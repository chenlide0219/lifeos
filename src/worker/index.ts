/**
 * Life OS 通知 Worker（PRD FR-07）
 *
 * 设计要点：
 * - 任务全部持久化在 notification_jobs，不依赖浏览器或个人电脑常开；
 * - 单实例由 PostgreSQL 咨询锁保证，任务领取用 FOR UPDATE SKIP LOCKED + 租约，
 *   并发下不会重复调度；
 * - 失败指数退避，最多 max_attempts 次；
 * - 严重超时未发（服务中断期间错过）的任务标记为 missed，不补发、不轰炸；
 * - 下游渠道未配置时不消费任务，保持 pending，既不丢也不伪造送达。
 */
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { db, pool } from '../server/db/client';
import { notificationAttempts, notificationJobs, notificationRules } from '../server/db/schema';
import { getProvider } from './registry';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_MS ?? 20_000);
const BATCH_SIZE = Number(process.env.WORKER_BATCH ?? 10);
const LEASE_MINUTES = 5;
/** 超过该时长仍未发出的提醒视为“错过”，不再补发（PRD FR-07） */
const MISSED_AFTER_MINUTES = Number(process.env.MISSED_AFTER_MINUTES ?? 120);
/** 重试退避：第 1/2/3 次失败后分别等待 1/5/15 分钟 */
const BACKOFF_SECONDS = [60, 300, 900];

type ClaimedJob = {
  id: string;
  ruleId: string | null;
  subjectType: string;
  subjectId: string;
  title: string;
  body: string;
  attempts: number;
  maxAttempts: number;
  idempotencyKey: string;
};

/** 持有咨询锁的连接：必须在退出时显式归还，否则连接池无法关闭 */
let lockClient: PoolClient | null = null;

/** 回收租约过期（Worker 崩溃/重启）的“发送中”任务 */
async function reclaimExpiredLeases(): Promise<number> {
  const rows = await db.execute(sql`
    UPDATE notification_jobs
    SET status = 'pending', leased_until = NULL, updated_at = now()
    WHERE status = 'sending' AND leased_until IS NOT NULL AND leased_until < now()
    RETURNING id
  `);
  return rows.rowCount ?? 0;
}

/** 标记错过的提醒：错过就是错过，不补发、不轰炸 */
async function markMissed(): Promise<number> {
  const rows = await db.execute(sql`
    UPDATE notification_jobs
    SET status = 'missed', updated_at = now(),
        last_error = COALESCE(last_error, '服务中断期间错过发送时间')
    WHERE status = 'pending'
      AND fire_at < now() - ${sql.raw(`interval '${MISSED_AFTER_MINUTES} minutes'`)}
    RETURNING id
  `);
  return rows.rowCount ?? 0;
}

/** 原子领取到期任务：SKIP LOCKED 保证多实例下也不重复 */
async function claimDueJobs(): Promise<ClaimedJob[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: notificationJobs.id,
        ruleId: notificationJobs.ruleId,
        subjectType: notificationJobs.subjectType,
        subjectId: notificationJobs.subjectId,
        title: notificationJobs.title,
        body: notificationJobs.body,
        attempts: notificationJobs.attempts,
        maxAttempts: notificationJobs.maxAttempts,
        idempotencyKey: notificationJobs.idempotencyKey,
      })
      .from(notificationJobs)
      .where(
        and(
          eq(notificationJobs.status, 'pending'),
          lte(notificationJobs.fireAt, new Date()),
          or(isNull(notificationJobs.nextAttemptAt), lte(notificationJobs.nextAttemptAt, new Date())),
        ),
      )
      .orderBy(asc(notificationJobs.fireAt))
      .limit(BATCH_SIZE)
      .for('update', { skipLocked: true });

    if (rows.length === 0) return [];

    await tx
      .update(notificationJobs)
      .set({
        status: 'sending',
        leasedUntil: sql`now() + ${sql.raw(`interval '${LEASE_MINUTES} minutes'`)}`,
        attempts: sql`${notificationJobs.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(
        inArray(
          notificationJobs.id,
          rows.map((r) => r.id),
        ),
      );

    return rows;
  });
}

async function resolveChannels(jobs: ClaimedJob[]): Promise<Map<string, string>> {
  const ruleIds = [...new Set(jobs.map((j) => j.ruleId).filter((id): id is string => Boolean(id)))];
  const map = new Map<string, string>();
  if (ruleIds.length === 0) return map;

  const rules = await db
    .select({ id: notificationRules.id, channel: notificationRules.channel })
    .from(notificationRules)
    .where(inArray(notificationRules.id, ruleIds));

  for (const rule of rules) map.set(rule.id, rule.channel);
  return map;
}

async function dispatch(job: ClaimedJob, channel: string): Promise<void> {
  const provider = getProvider(channel);

  if (!provider) {
    await finishWithFailure(job, `未知通知渠道：${channel}`, true);
    return;
  }

  const result = await provider.send({
    jobId: job.id,
    title: job.title,
    body: job.body,
    subjectType: job.subjectType,
    subjectId: job.subjectId,
    idempotencyKey: job.idempotencyKey,
  });

  try {
    await db.insert(notificationAttempts).values({
      jobId: job.id,
      success: result.ok,
      error: result.ok ? null : result.error,
    });
  } catch (err) {
    console.error('[worker] 记录发送尝试失败:', (err as Error).message);
  }

  if (result.ok) {
    await db
      .update(notificationJobs)
      .set({ status: 'sent', sentAt: new Date(), lastError: null, leasedUntil: null, updatedAt: new Date() })
      .where(eq(notificationJobs.id, job.id));
    console.log(`[worker] 已发送 ${job.id}（${job.subjectType}）`);
    return;
  }

  await finishWithFailure(job, result.error, result.permanent === true);
}

async function finishWithFailure(job: ClaimedJob, error: string, permanent: boolean): Promise<void> {
  const exhausted = job.attempts >= job.maxAttempts;

  if (permanent || exhausted) {
    await db
      .update(notificationJobs)
      .set({ status: 'failed', lastError: error, leasedUntil: null, updatedAt: new Date() })
      .where(eq(notificationJobs.id, job.id));
    console.error(`[worker] 发送失败（已放弃）${job.id}: ${error}`);
    return;
  }

  const waitSeconds = BACKOFF_SECONDS[Math.min(job.attempts - 1, BACKOFF_SECONDS.length - 1)]!;
  await db
    .update(notificationJobs)
    .set({
      status: 'pending',
      lastError: error,
      leasedUntil: null,
      nextAttemptAt: new Date(Date.now() + waitSeconds * 1000),
      updatedAt: new Date(),
    })
    .where(eq(notificationJobs.id, job.id));
  console.warn(`[worker] 发送失败，${waitSeconds}s 后重试（第 ${job.attempts}/${job.maxAttempts} 次）${job.id}: ${error}`);
}

let lastUnconfiguredWarnAt = 0;
function warnUnconfigured(detail: string): void {
  // 未配置渠道时每 10 分钟提醒一次，避免刷屏日志
  if (Date.now() - lastUnconfiguredWarnAt < 10 * 60 * 1000) return;
  lastUnconfiguredWarnAt = Date.now();
  console.warn(`[worker] 渠道未配置，暂不消费提醒任务（任务保持 pending 不会丢失）：${detail}`);
}

async function tick(): Promise<void> {
  const reclaimed = await reclaimExpiredLeases();
  if (reclaimed > 0) console.warn(`[worker] 回收 ${reclaimed} 条租约过期的任务`);

  const missed = await markMissed();
  if (missed > 0) console.warn(`[worker] 标记 ${missed} 条错过的提醒（不补发）`);

  const jobs = await claimDueJobs();
  if (jobs.length === 0) return;

  const channels = await resolveChannels(jobs);

  // 渠道未配置时不消费：任务留在 pending，配置好后自然补齐
  const firstProvider = getProvider(channels.get(jobs[0]!.ruleId ?? '') ?? 'wechat');
  if (firstProvider && !firstProvider.isConfigured()) {
    warnUnconfigured(firstProvider.describe().detail);
    await db
      .update(notificationJobs)
      .set({
        status: 'pending',
        leasedUntil: null,
        attempts: sql`${notificationJobs.attempts} - 1`,
        updatedAt: new Date(),
      })
      .where(
        inArray(
          notificationJobs.id,
          jobs.map((j) => j.id),
        ),
      );
    return;
  }

  for (const job of jobs) {
    const channel = (job.ruleId && channels.get(job.ruleId)) || 'wechat';
    try {
      await dispatch(job, channel);
    } catch (err) {
      console.error(`[worker] 调度异常 ${job.id}:`, (err as Error).message);
      await finishWithFailure(job, (err as Error).message.slice(0, 200), false).catch(() => undefined);
    }
  }
}

async function main(): Promise<void> {
  // 咨询锁：同一数据库只允许一个 Worker 实例，避免重复调度
  lockClient = await pool.connect();
  const lock = await lockClient.query<{ ok: boolean }>(
    `select pg_try_advisory_lock(hashtext('lifeos_worker')) as ok`,
  );

  if (!lock.rows[0]?.ok) {
    console.error('[worker] 已有 Worker 实例持有锁，本实例退出');
    lockClient.release();
    lockClient = null;
    process.exit(0);
  }

  console.log(
    `[worker] 已启动：轮询 ${POLL_INTERVAL_MS}ms，批次 ${BATCH_SIZE}，错过阈值 ${MISSED_AFTER_MINUTES} 分钟`,
  );

  let running = true;
  let consecutiveErrors = 0;

  while (running) {
    try {
      await tick();
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors += 1;
      console.error(`[worker] 轮询异常（连续 ${consecutiveErrors} 次）:`, (err as Error).message);
      // 数据库短暂不可用时退避，避免打爆日志与连接池
      if (consecutiveErrors > 3) await new Promise((r) => setTimeout(r, 30_000));
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] 收到 ${signal}，停止轮询…`);

  // 必须留出兜底：任何一步卡住都不能让 systemd 等到超时强杀
  const forceExit = setTimeout(() => {
    console.error('[worker] 退出超时，强制结束');
    process.exit(1);
  }, 8_000);
  forceExit.unref();

  // 关键：先释放长期占用的咨询锁连接，否则 pool.end() 会一直等待它归还而挂死
  if (lockClient) {
    try {
      await lockClient.query(`select pg_advisory_unlock(hashtext('lifeos_worker'))`);
    } catch {
      /* 连接可能已断开，忽略 */
    }
    lockClient.release();
    lockClient = null;
  }

  // 未发完的任务保持 pending，下次启动继续；租约到期后也会被回收
  await pool.end().catch(() => undefined);
  clearTimeout(forceExit);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  console.error('[worker] 启动失败:', err);
  process.exit(1);
});

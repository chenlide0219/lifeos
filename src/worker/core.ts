/**
 * 通知 Worker 的核心逻辑（PRD FR-07）。
 *
 * 与入口分离的原因：入口要持有咨询锁、装信号处理并启动常驻循环，
 * 导入即产生副作用会让回归测试无法加载真实逻辑。这里全部是无副作用的可测函数。
 *
 * 结果处理政策（对应验收 A1 / A2 / A7）：
 * - 渠道未配置 → **不领取**任何发送任务，不记尝试、不伪造送达；
 * - 超过错过阈值 → 标记 missed 并**写明原因**，按政策不补发；
 * - 发送中断遗留的 sending → 结果未知，**绝不自动重试**，标记为需人工核实；
 * - 明确可重试才重试；明确拒绝 / 需人工介入 / 结果未知一律终止。
 */
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../server/db/client';
import { notificationAttempts, notificationJobs, notificationRules } from '../server/db/schema';
import type { NotificationProvider, SendFailureKind } from './provider';
import { getProvider, hasConfiguredProvider, unconfiguredDetail, refreshProviders, listProviders } from './registry';

export const BATCH_SIZE = Number(process.env.WORKER_BATCH ?? 10);
export const LEASE_MINUTES = Number(process.env.WORKER_LEASE_MINUTES ?? 5);
/** 超过该时长仍未发出的提醒视为"错过"，不再补发（PRD FR-07） */
export const MISSED_AFTER_MINUTES = Number(process.env.MISSED_AFTER_MINUTES ?? 120);
/** 重试退避：第 1/2/3 次失败后分别等待 1/5/15 分钟 */
export const BACKOFF_SECONDS = [60, 300, 900];

/**
 * 第 attempts 次尝试失败后应等待的秒数。
 * attempts 必须是**本次领取之后**的次数（1 起），否则首次失败会取到下标 -1。
 */
export function backoffSecondsFor(attempts: number): number {
  const index = Math.max(0, Math.min(attempts - 1, BACKOFF_SECONDS.length - 1));
  return BACKOFF_SECONDS[index]!;
}

/** 是否已耗尽重试次数（attempts 为本次领取后的次数） */
export function isExhausted(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}

export type ClaimedJob = {
  id: string;
  ruleId: string | null;
  subjectType: string;
  subjectId: string;
  title: string;
  body: string;
  /** **本次领取之后**的尝试次数（数据库已 +1），退避与上限一律以此为准 */
  attempts: number;
  maxAttempts: number;
  idempotencyKey: string;
};

export type TickResult = {
  reclaimed: number;
  missed: number;
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  released: number;
  skippedUnconfigured: boolean;
};

export type TickContext = {
  shuttingDown: boolean;
};

const EMPTY_RESULT: TickResult = {
  reclaimed: 0,
  missed: 0,
  claimed: 0,
  sent: 0,
  retried: 0,
  failed: 0,
  released: 0,
  skippedUnconfigured: false,
};

/**
 * 回收被遗弃的"发送中"任务。
 *
 * 关键决策：不盲目重试。任务处于 sending 说明 Worker 在发送过程中中断，
 * 我们**无法得知下游是否已接受**，重发可能造成重复送达。
 * 按"不盲目重试 UNKNOWN"的政策，这里标记为需要人工核实的失败，而不是退回 pending。
 */
export async function reclaimAbandonedSends(): Promise<number> {
  const rows = await db.execute(sql`
    UPDATE notification_jobs
    SET status = 'failed',
        failure_kind = 'unknown',
        leased_until = NULL,
        last_error = 'WORKER_INTERRUPTED_DURING_SEND: 发送过程中 Worker 中断，结果未知；'
                     || '按不盲目重试政策不自动重发，请人工核实手机是否已收到',
        updated_at = now()
    WHERE status = 'sending' AND leased_until IS NOT NULL AND leased_until < now()
    RETURNING id
  `);
  return rows.rowCount ?? 0;
}

/**
 * 标记错过的提醒：错过就是错过，不补发。
 * 原因写入 last_error，必须能在界面查到（验收 A7）。
 */
export async function markMissed(configured = hasConfiguredProvider()): Promise<number> {
  const reason = configured
    ? `超过错过阈值 ${MISSED_AFTER_MINUTES} 分钟仍未发出（服务中断或调度延迟期间到期），按政策不补发`
    : `发送通道未配置（${unconfiguredDetail()}），该提醒到期时无法发出且已超过错过阈值 ${MISSED_AFTER_MINUTES} 分钟，按政策不补发`;

  const rows = await db.execute(sql`
    UPDATE notification_jobs
    SET status = 'missed',
        leased_until = NULL,
        last_error = ${reason},
        updated_at = now()
    WHERE status = 'pending'
      AND fire_at < now() - ${sql.raw(`interval '${MISSED_AFTER_MINUTES} minutes'`)}
    RETURNING id
  `);
  return rows.rowCount ?? 0;
}

/** 原子领取到期任务：SKIP LOCKED 保证多实例下也不重复 */
export async function claimDueJobs(): Promise<ClaimedJob[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: notificationJobs.id,
        ruleId: notificationJobs.ruleId,
        subjectType: notificationJobs.subjectType,
        subjectId: notificationJobs.subjectId,
        title: notificationJobs.title,
        body: notificationJobs.body,
        attemptsBefore: notificationJobs.attempts,
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

    // 数据库已把这些任务的 attempts 加一，返回对象必须同步为"本次领取后"的次数，
    // 否则退避会取到 BACKOFF_SECONDS[-1]（生成非法时间），上限判断也会晚一轮。
    return rows.map(({ attemptsBefore, ...rest }) => ({ ...rest, attempts: attemptsBefore + 1 }));
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

async function recordAttempt(jobId: string, success: boolean, error: string | null): Promise<void> {
  try {
    await db.insert(notificationAttempts).values({ jobId, success, error });
  } catch (err) {
    console.error('[worker] 记录发送尝试失败:', (err as Error).message);
  }
}

export async function markSent(jobId: string): Promise<void> {
  await db
    .update(notificationJobs)
    .set({
      status: 'sent',
      sentAt: new Date(),
      lastError: null,
      failureKind: null,
      leasedUntil: null,
      // 成功后不得残留重试时间，否则界面会显示"下次重试"
      nextAttemptAt: null,
      updatedAt: new Date(),
    })
    .where(eq(notificationJobs.id, jobId));
}

export async function markFailed(
  jobId: string,
  kind: SendFailureKind | 'exhausted',
  error: string,
): Promise<void> {
  await db
    .update(notificationJobs)
    .set({
      status: 'failed',
      failureKind: kind,
      lastError: error.slice(0, 500),
      leasedUntil: null,
      // 终止态必须清空重试时间，否则残留的旧值会让界面误以为还会重试
      nextAttemptAt: null,
      updatedAt: new Date(),
    })
    .where(eq(notificationJobs.id, jobId));
}

export async function scheduleRetry(job: ClaimedJob, error: string): Promise<number> {
  const waitSeconds = backoffSecondsFor(job.attempts);
  await db
    .update(notificationJobs)
    .set({
      status: 'pending',
      lastError: error.slice(0, 500),
      failureKind: 'retryable',
      leasedUntil: null,
      nextAttemptAt: new Date(Date.now() + waitSeconds * 1000),
      updatedAt: new Date(),
    })
    .where(eq(notificationJobs.id, job.id));
  return waitSeconds;
}

/** 把已领取但尚未发送的任务交还 pending（退出流程使用） */
async function releaseJob(jobId: string): Promise<void> {
  await db
    .update(notificationJobs)
    .set({
      status: 'pending',
      leasedUntil: null,
      attempts: sql`GREATEST(${notificationJobs.attempts} - 1, 0)`,
      updatedAt: new Date(),
    })
    .where(eq(notificationJobs.id, jobId));
}

export type DispatchOutcome = 'sent' | 'retried' | 'failed' | 'released';

export async function dispatch(
  job: ClaimedJob,
  provider: NotificationProvider,
): Promise<DispatchOutcome> {
  const result = await provider.send({
    jobId: job.id,
    title: job.title,
    body: job.body,
    subjectType: job.subjectType,
    subjectId: job.subjectId,
    idempotencyKey: job.idempotencyKey,
  });

  if (result.ok) {
    await recordAttempt(job.id, true, null);
    await markSent(job.id);
    console.log(`[worker] 已发送 ${job.id}（${job.subjectType}）: ${result.detail}`);
    return 'sent';
  }

  if (result.kind === 'deferred') {
    await releaseJob(job.id);
    return 'released';
  }

  await recordAttempt(job.id, false, result.error);

  if (result.kind === 'retryable') {
    if (isExhausted(job.attempts, job.maxAttempts)) {
      await markFailed(job.id, 'exhausted', `RETRY_EXHAUSTED(第 ${job.attempts} 次仍失败): ${result.error}`);
      console.error(`[worker] 重试次数耗尽，放弃 ${job.id}: ${result.error}`);
      return 'failed';
    }
    const wait = await scheduleRetry(job, result.error);
    console.warn(
      `[worker] 发送失败，${wait}s 后重试（第 ${job.attempts}/${job.maxAttempts} 次）${job.id}: ${result.error}`,
    );
    return 'retried';
  }

  // rejected / needs_human / unknown 一律终止：unknown 表示可能已送达，重试会造成重复
  const prefix =
    result.kind === 'unknown'
      ? 'UNKNOWN_MAYBE_DELIVERED'
      : result.kind === 'needs_human'
        ? 'NEEDS_HUMAN'
        : 'REJECTED';
  await markFailed(job.id, result.kind, `${prefix}: ${result.error}`);
  console.error(`[worker] 终止 ${job.id}（${result.kind}）: ${result.error}`);
  return 'failed';
}

let lastUnconfiguredWarnAt = 0;
export function warnUnconfigured(): void {
  if (Date.now() - lastUnconfiguredWarnAt < 10 * 60 * 1000) return;
  lastUnconfiguredWarnAt = Date.now();
  console.warn(
    `[worker] 渠道未配置，不领取任何发送任务（任务保留在 pending，超过错过阈值后将标记 missed 并写明原因）：${unconfiguredDetail()}`,
  );
}

/** 单次轮询：回收 → 标记错过 → （渠道可用才）领取并派发 */
export async function tick(ctx: TickContext = { shuttingDown: false }): Promise<TickResult> {
  const result: TickResult = { ...EMPTY_RESULT };

  result.reclaimed = await reclaimAbandonedSends();
  if (result.reclaimed > 0) {
    console.warn(`[worker] ${result.reclaimed} 条任务在发送中断，已标记为结果未知（不自动重发，需人工核实）`);
  }

  await refreshProviders();
  // A user-requested context pause retains pending reminders, including overdue ones.
  if (listProviders().some(p => p.isConfigured() && p.canSend && !p.canSend())) return result;
  const configured = hasConfiguredProvider();
  result.missed = await markMissed(configured);
  if (result.missed > 0) {
    console.warn(`[worker] 标记 ${result.missed} 条错过的提醒（未补发，原因已记录，可在界面查询）`);
  }

  // 渠道未配置时绝不领取：不消费、不记尝试、不伪造送达
  if (!configured) {
    result.skippedUnconfigured = true;
    warnUnconfigured();
    return result;
  }

  const jobs = await claimDueJobs();
  result.claimed = jobs.length;
  if (jobs.length === 0) return result;

  const channels = await resolveChannels(jobs);

  for (const job of jobs) {
    // 退出流程开始后，已领取但未发送的任务交还 pending，下次启动立即处理
    if (ctx.shuttingDown) {
      await releaseJob(job.id);
      result.released += 1;
      continue;
    }

    const channel = (job.ruleId && channels.get(job.ruleId)) || 'wechat';
    const provider = getProvider(channel);

    if (!provider) {
      await markFailed(job.id, 'rejected', `UNKNOWN_CHANNEL: 未注册的通知渠道 ${channel}`);
      result.failed += 1;
      continue;
    }

    try {
      const outcome = await dispatch(job, provider);
      if (outcome === 'sent') result.sent += 1;
      else if (outcome === 'retried') result.retried += 1;
      else if (outcome === 'released') result.released += 1;
      else result.failed += 1;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      console.error(`[worker] 调度异常 ${job.id}:`, message);
      await recordAttempt(job.id, false, message);
      if (isExhausted(job.attempts, job.maxAttempts)) {
        await markFailed(job.id, 'exhausted', `DISPATCH_ERROR: ${message}`);
      } else {
        await scheduleRetry(job, `DISPATCH_ERROR: ${message}`);
        result.retried += 1;
        continue;
      }
      result.failed += 1;
    }
  }

  return result;
}

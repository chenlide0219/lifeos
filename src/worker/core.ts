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
import { getProvider, refreshProviders } from './registry';
import { canSendWechat, listBoundWechatAccounts, unseal, type WechatAccount } from '../server/lib/wechat-state';

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
  /**
   * 归属账号。它同时决定两件事：
   *   - 领取资格：只有该账号**自己**的微信绑定可用时才允许领取；
   *   - 发送凭据：用该账号自己的 token/上下文，绝不能借别人的。
   */
  userId: number;
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
 * 某个账号"发不出去"的原因。
 *
 * 多用户下原因必须按账号区分，不能混成一句通用文案：**没绑微信**、绑了但
 * 上下文还没就绪、发送窗口被暂停，与"服务中断导致超时"是完全不同的处置线索。
 * 写成一句"通道未配置"会让用户以为是自己漏看了提醒，从而不去处理真正的问题。
 */
export function missedReasonFor(account: WechatAccount | undefined): string {
  if (!account?.account) {
    return (
      `该账号尚未绑定微信，提醒无法发送；已超过错过阈值 ${MISSED_AFTER_MINUTES} 分钟，按政策不补发。` +
      `请到「设置 → 微信提醒」扫码绑定后重新开启提醒。`
    );
  }
  // 凭据存在但解不开（例如 SESSION_SECRET 变过）：必须明确指向"重新扫码"，
  // 否则用户看到的是通用超时文案，会往"是不是提醒设置错了"的方向排查。
  try {
    unseal<unknown>(account.account);
  } catch {
    return (
      `该账号的微信凭据无法解密（通常是服务端 SESSION_SECRET 变更导致）；` +
      `已超过错过阈值 ${MISSED_AFTER_MINUTES} 分钟，按政策不补发。请重新扫码绑定。`
    );
  }
  return `超过错过阈值 ${MISSED_AFTER_MINUTES} 分钟仍未发出（服务中断或调度延迟期间到期），按政策不补发`;
}

/**
 * 标记错过的提醒：错过就是错过，不补发。原因逐账号写入 `last_error`。
 *
 * 两种情况下**不**标记 missed，保持 pending：
 * - 该账号已绑定但当前不可发送（等上下文、窗口暂停、登录过期）——用户发一条消息
 *   或重新扫码即可恢复，此时标 missed 等于把"可恢复"说成"已错过"（沿用改造前
 *   "用户主动暂停期间保留待发提醒"的语义）；
 * - 该账号一个到期任务都没有（无需处理）。
 */
export async function markMissed(): Promise<number> {
  const overdue = await db.execute(sql`
    SELECT DISTINCT user_id
    FROM notification_jobs
    WHERE status = 'pending'
      AND fire_at < now() - ${sql.raw(`interval '${MISSED_AFTER_MINUTES} minutes'`)}
  `);
  const overdueUserIds = (overdue.rows as { user_id: number }[]).map((r) => r.user_id);
  if (overdueUserIds.length === 0) return 0;

  const accounts = new Map((await listBoundWechatAccounts()).map((a) => [a.userId, a]));

  let total = 0;
  for (const userId of overdueUserIds) {
    const account = accounts.get(userId);
    // 已绑定但暂时不可发 → 保留 pending 等恢复，不标 missed
    if (account?.account && !canSendWechat(account)) continue;

    const rows = await db.execute(sql`
      UPDATE notification_jobs
      SET status = 'missed',
          leased_until = NULL,
          last_error = ${missedReasonFor(account)},
          updated_at = now()
      WHERE status = 'pending'
        AND user_id = ${userId}
        AND fire_at < now() - ${sql.raw(`interval '${MISSED_AFTER_MINUTES} minutes'`)}
      RETURNING id
    `);
    total += rows.rowCount ?? 0;
  }
  return total;
}

/**
 * 原子领取到期任务：SKIP LOCKED 保证多实例下也不重复。
 *
 * **必须传入"当前可发送的账号集合"**，这是多用户下最关键的一处安全约束：
 * 改造前的判断是"全局有没有配置渠道"，那在多用户下会直接造成把 A 的提醒
 * 用 B 的微信发出去（只要 B 绑定了而 A 没有）。因此领取资格必须逐账号判断：
 * 只有该任务所属账号**自己**的绑定可用时，才允许把它领出来。
 */
export async function claimDueJobs(sendableUserIds: number[] = []): Promise<ClaimedJob[]> {
  // 一个账号都不满足时不领取：不消费、不记尝试、不伪造送达。
  // 默认值为空数组是**有意** fail closed：调用方漏传参数时必须"什么都不领"，
  // 而不是崩溃——崩在轮询循环里会让整个 Worker 停摆。
  if (!Array.isArray(sendableUserIds) || sendableUserIds.length === 0) return [];

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: notificationJobs.id,
        ruleId: notificationJobs.ruleId,
        userId: notificationJobs.userId,
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
          inArray(notificationJobs.userId, sendableUserIds),
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

/**
 * 解析每条任务该用哪个渠道发送。
 *
 * 多用户下这里也带归属校验：只有"规则的归属 == 任务的归属"时才采用该规则的渠道，
 * 否则退回默认渠道。正常情况下两者必然一致（复合外键保证），这里是防御性检查——
 * 一旦出现不一致，宁可走默认渠道并留下痕迹，也不要照着一个可疑的规则去发送。
 */
async function resolveChannels(jobs: ClaimedJob[]): Promise<Map<string, string>> {
  const ruleIds = [...new Set(jobs.map((j) => j.ruleId).filter((id): id is string => Boolean(id)))];
  const map = new Map<string, string>();
  if (ruleIds.length === 0) return map;

  const rules = await db
    .select({
      id: notificationRules.id,
      channel: notificationRules.channel,
      userId: notificationRules.userId,
    })
    .from(notificationRules)
    .where(inArray(notificationRules.id, ruleIds));

  const byId = new Map(rules.map((r) => [r.id, r]));
  for (const job of jobs) {
    if (!job.ruleId) continue;
    const rule = byId.get(job.ruleId);
    if (!rule) continue;
    if (rule.userId !== job.userId) {
      console.warn(
        `[worker] 规则 ${rule.id} 的归属与任务 ${job.id} 不一致，已忽略该规则，按默认渠道处理`,
      );
      continue;
    }
    map.set(rule.id, rule.channel);
  }
  return map;
}

async function recordAttempt(
  jobId: string,
  userId: number,
  success: boolean,
  error: string | null,
): Promise<void> {
  try {
    // userId 必须与所属任务一致：复合外键会在数据库层拒绝写错的归属
    await db.insert(notificationAttempts).values({ jobId, userId, success, error });
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
    // 发送方据此解析**该账号自己**的微信凭据与发送窗口，绝不借用别人的
    userId: job.userId,
    title: job.title,
    body: job.body,
    subjectType: job.subjectType,
    subjectId: job.subjectId,
    idempotencyKey: job.idempotencyKey,
  });

  if (result.ok) {
    await recordAttempt(job.id, job.userId, true, null);
    await markSent(job.id);
    console.log(`[worker] 已发送 ${job.id}（${job.subjectType}）: ${result.detail}`);
    return 'sent';
  }

  if (result.kind === 'deferred') {
    await releaseJob(job.id);
    return 'released';
  }

  await recordAttempt(job.id, job.userId, false, result.error);

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
/**
 * 没有任何账号可发送时的提示（每 10 分钟最多一条）。
 *
 * 参数是"已绑定账号数"，用来区分两种完全不同的处境：
 * 一个都没绑（用户需要去扫码），还是绑了但都暂停了（用户需要发一条消息刷新窗口）。
 * 混成一句"渠道未配置"会让人往错误的方向排查。
 */
export function warnNoSendableAccount(boundCount: number): void {
  if (Date.now() - lastUnconfiguredWarnAt < 10 * 60 * 1000) return;
  lastUnconfiguredWarnAt = Date.now();
  const detail =
    boundCount === 0
      ? '没有任何账号绑定微信'
      : `${boundCount} 个账号已绑定微信，但当前都不可发送（等待上下文或发送窗口已暂停）`;
  console.warn(
    `[worker] ${detail}，不领取任何发送任务（任务保留在 pending，超过错过阈值后将标记 missed 并写明原因）`,
  );
}

/**
 * 单次轮询：回收 → 逐账号标记错过 → （该账号自己的渠道可用才）领取并派发。
 *
 * ⚠️ 这里是多用户改造中最关键的一处安全边界。
 * 改造前是"全局有没有配置渠道"，那在多用户下会出现：
 * 只要 B 绑定了微信而 A 没有，A 的提醒任务就会被领出来并用 **B 的微信** 发出去。
 * 因此"能不能发"必须**逐账号**判断，暂停也只影响该账号自己。
 */
export async function tick(ctx: TickContext = { shuttingDown: false }): Promise<TickResult> {
  const result: TickResult = { ...EMPTY_RESULT };

  result.reclaimed = await reclaimAbandonedSends();
  if (result.reclaimed > 0) {
    console.warn(`[worker] ${result.reclaimed} 条任务在发送中断，已标记为结果未知（不自动重发，需人工核实）`);
  }

  await refreshProviders();

  // 逐账号判定发送资格：已绑定且未被暂停（窗口未用尽、上下文就绪）
  const accounts = await listBoundWechatAccounts();
  const sendableUserIds = accounts.filter((a) => canSendWechat(a)).map((a) => a.userId);

  // 标记错过时同样逐账号判断：已绑定但暂时不可发的账号保留 pending 等恢复
  result.missed = await markMissed();
  if (result.missed > 0) {
    console.warn(`[worker] 标记 ${result.missed} 条错过的提醒（未补发，原因已记录，可在界面查询）`);
  }

  // 一个账号都不可发送时绝不领取：不消费、不记尝试、不伪造送达
  if (sendableUserIds.length === 0) {
    result.skippedUnconfigured = true;
    warnNoSendableAccount(accounts.length);
    return result;
  }

  const jobs = await claimDueJobs(sendableUserIds);
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

    // 渠道名取自该任务自己的规则；解析结果必须与任务同属一个账号，否则视为未注册
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
      await recordAttempt(job.id, job.userId, false, message);
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

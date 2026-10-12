/**
 * 微信出站队列（PRD 7.3、8.1）。
 *
 * 为什么与 `notification_jobs` 分开：
 * - 通知任务是"事项提醒"，面向调度，有重试与三态语义；
 * - 微信回复是"一次对话应答"，绑定**操作版本**：草稿被修改、被取消、
 *   被换绑之后，旧回复必须**作废**而不是补发（PRD 7.3：
 *   "Outbox 绑定代际、操作及草稿版本；换绑后的旧回复和被替代的未发送预览作废"）。
 * 把两者塞进一张表会让"过期回复"变成难以表达的谓词。
 *
 * 发送计数**不在这里**：统一沿用既有 8/10 窗口实现（managed-wechat provider），
 * 避免出现两个各自计数的窗口。
 */
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { wechatOutbox } from '../db/schema';
import { config } from '../config';

/** 正文保留天数：与 inbox 一致，终态审计不随正文清理（PRD 16.1-4） */
const BODY_RETENTION_DAYS = Number(process.env.WECHAT_BODY_RETENTION_DAYS ?? 7);
export const OUTBOX_LEASE_MINUTES = Number(process.env.WECHAT_OUTBOX_LEASE_MINUTES ?? 5);
export const OUTBOX_MAX_ATTEMPTS = Number(process.env.WECHAT_OUTBOX_MAX_ATTEMPTS ?? 3);

export type ReplyType =
  | 'preview'
  | 'created'
  | 'cancelled'
  | 'expired'
  | 'error'
  | 'help'
  | 'query'
  | 'pending'
  | 'recent'
  | 'notice';

/**
 * 事务客户端的结构化类型。
 *
 * 只声明本模块实际用到的方法，因此 `db` 与事务对象 `tx` 都能传入。
 * 这样"操作提交 + 回复入队"可以在同一个事务里完成——这是原子性的前提：
 * 若回复入队失败就必须整体回滚，否则会出现"事项已建但没有回复"或反之。
 */
export type TxLike = {
  insert: typeof db.insert;
  update: typeof db.update;
  select: typeof db.select;
  execute: typeof db.execute;
};

export type EnqueueInput = {
  bindingGeneration: string;
  operationId?: string | null;
  sourceInboxId?: string | null;
  operationVersion?: number | null;
  replyType: ReplyType;
  body: string;
  /** 去重键：同一次应答只能入队一次 */
  dedupeKey: string;
  now?: Date;
};

/** 入队一条回复；返回是否新建（重复入队返回 false，不抛错） */
export async function enqueueReply(tx: TxLike, input: EnqueueInput): Promise<boolean> {
  const now = input.now ?? new Date();
  const rows = await tx
    .insert(wechatOutbox)
    .values({
      bindingGeneration: input.bindingGeneration,
      operationId: input.operationId ?? null,
      sourceInboxId: input.sourceInboxId ?? null,
      operationVersion: input.operationVersion ?? null,
      replyType: input.replyType,
      body: input.body,
      dedupeKey: input.dedupeKey,
      status: 'pending',
      purgeAfter: new Date(now.getTime() + BODY_RETENTION_DAYS * 86_400_000),
    })
    .onConflictDoNothing({ target: wechatOutbox.dedupeKey })
    .returning({ id: wechatOutbox.id });
  return rows.length > 0;
}

export type PendingReply = {
  id: string;
  bindingGeneration: string;
  operationId: string | null;
  operationVersion: number | null;
  replyType: string;
  body: string;
  attempts: number;
  maxAttempts: number;
  dedupeKey: string;
  createdAt: Date;
};

/**
 * 领取待发送回复。
 *
 * 与 inbox 一样用租约而非长事务：发送是网络调用，绝不能持有事务。
 */
export async function claimOutboxBatch(limit = 3, now = new Date()): Promise<PendingReply[]> {
  return db.transaction(async (tx) => {
    const claimed = await tx.execute<{ id: string }>(sql`
      SELECT id FROM wechat_outbox
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${now.toISOString()})
        AND attempts < max_attempts
      ORDER BY created_at ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);
    const ids = (claimed.rows ?? []).map((r) => r.id);
    if (ids.length === 0) return [];

    const leaseUntil = new Date(now.getTime() + OUTBOX_LEASE_MINUTES * 60_000);
    await tx
      .update(wechatOutbox)
      .set({ status: 'sending', leasedUntil: leaseUntil, attempts: sql`${wechatOutbox.attempts} + 1` })
      .where(sql`${wechatOutbox.id} = ANY(${ids}::uuid[])`);

    return tx
      .select({
        id: wechatOutbox.id,
        bindingGeneration: wechatOutbox.bindingGeneration,
        operationId: wechatOutbox.operationId,
        operationVersion: wechatOutbox.operationVersion,
        replyType: wechatOutbox.replyType,
        body: wechatOutbox.body,
        attempts: wechatOutbox.attempts,
        maxAttempts: wechatOutbox.maxAttempts,
        dedupeKey: wechatOutbox.dedupeKey,
        createdAt: wechatOutbox.createdAt,
      })
      .from(wechatOutbox)
      .where(sql`${wechatOutbox.id} = ANY(${ids}::uuid[])`)
      .orderBy(asc(wechatOutbox.createdAt));
  });
}

/**
 * 发送前重新核对：代际是否仍是当前代际、操作版本是否仍是最新。
 *
 * 这是"过时回复作废"的执行点：领取与发送之间可能发生换绑或草稿修改，
 * 所以**发送前**必须再查一次，而不是信任领取时的快照。
 */
export async function isReplyStillValid(reply: {
  bindingGeneration: string;
  operationId: string | null;
  operationVersion: number | null;
}): Promise<{ valid: boolean; reason: string | null }> {
  const rows = await db.execute<{ generation: string | null; account: string | null }>(sql`
    SELECT value->>'generation' AS generation, value->>'account' AS account
    FROM settings WHERE key = 'wechat.private-channel'
  `);
  const row = rows.rows?.[0];
  if (!row?.account) return { valid: false, reason: '尚未绑定微信，回复不发送' };
  if (row.generation !== reply.bindingGeneration) {
    return { valid: false, reason: '绑定已变更，旧回复作废' };
  }
  if (reply.operationId && reply.operationVersion !== null) {
    const opRows = await db.execute<{ version: number; status: string }>(sql`
      SELECT version, status FROM wechat_operations WHERE id = ${reply.operationId}
    `);
    const op = opRows.rows?.[0];
    if (op && op.version !== reply.operationVersion) {
      return { valid: false, reason: '草稿已被新版本替代，旧预览作废' };
    }
  }
  return { valid: true, reason: null };
}

/** 标记已发送 */
export async function markOutboxSent(id: string, now = new Date()): Promise<void> {
  await db
    .update(wechatOutbox)
    .set({ status: 'sent', sentAt: now, leasedUntil: null, nextAttemptAt: null, lastError: null })
    .where(eq(wechatOutbox.id, id));
}

/**
 * 作废（不发送）。用于过时回复：它是终态，不再重试，
 * 且**不计入已送达**，避免"以为发出去了"。
 */
export async function markOutboxSuppressed(id: string, reason: string): Promise<void> {
  await db
    .update(wechatOutbox)
    .set({ status: 'suppressed', leasedUntil: null, nextAttemptAt: null, lastError: reason.slice(0, 500) })
    .where(eq(wechatOutbox.id, id));
}

/**
 * 发送失败：按三态处理（PRD 7.3）。
 * - `unknown`：HTTP 200 但无可靠回执、超时、发送中中断 → **绝不自动重发**；
 * - 明确可重试 → 退避重试；
 * - 明确拒绝/需人工介入 → 终止。
 */
export async function markOutboxFailed(
  id: string,
  failureKind: 'retryable' | 'rejected' | 'needs_human' | 'unknown',
  error: string,
  now = new Date(),
): Promise<'pending' | 'failed'> {
  const [row] = await db
    .select({ attempts: wechatOutbox.attempts, maxAttempts: wechatOutbox.maxAttempts })
    .from(wechatOutbox)
    .where(eq(wechatOutbox.id, id))
    .limit(1);
  if (!row) return 'failed';

  const noRetry = failureKind === 'unknown' || failureKind === 'needs_human';
  const exhausted = row.attempts >= row.maxAttempts;

  if (noRetry || exhausted) {
    await db
      .update(wechatOutbox)
      .set({
        status: 'failed',
        failureKind,
        leasedUntil: null,
        nextAttemptAt: null,
        lastError: error.slice(0, 500),
      })
      .where(eq(wechatOutbox.id, id));
    return 'failed';
  }

  const backoffMinutes = [1, 5, 15][Math.min(row.attempts - 1, 2)] ?? 15;
  await db
    .update(wechatOutbox)
    .set({
      status: 'pending',
      failureKind,
      leasedUntil: null,
      nextAttemptAt: new Date(now.getTime() + backoffMinutes * 60_000),
      lastError: error.slice(0, 500),
    })
    .where(eq(wechatOutbox.id, id));
  return 'pending';
}

/** 回收超租约的 sending 记录（发出中断的情况按 unknown 处理，不自动重发） */
export async function reclaimStaleSending(now = new Date()): Promise<number> {
  const rows = await db
    .update(wechatOutbox)
    .set({
      status: 'failed',
      failureKind: 'unknown',
      leasedUntil: null,
      lastError: '发送中中断，结果未知；按策略不自动重发，请人工核实手机是否已收到',
    })
    .where(and(eq(wechatOutbox.status, 'sending'), isNotNull(wechatOutbox.leasedUntil), lte(wechatOutbox.leasedUntil, now)))
    .returning({ id: wechatOutbox.id });
  return rows.length;
}

/** 正文过期清理：只清正文，保留终态与投递结果 */
export async function purgeExpiredOutboxBodies(now = new Date()): Promise<number> {
  const rows = await db.execute(sql`
    UPDATE wechat_outbox SET body = ''
    WHERE purge_after IS NOT NULL AND purge_after <= ${now.toISOString()} AND body <> ''
  `);
  return (rows as unknown as { rowCount?: number }).rowCount ?? 0;
}

/** 供"最近操作"与设置页展示 */
export async function listRecentReplies(limit = 10) {
  return db
    .select({
      id: wechatOutbox.id,
      replyType: wechatOutbox.replyType,
      status: wechatOutbox.status,
      failureKind: wechatOutbox.failureKind,
      operationId: wechatOutbox.operationId,
      sentAt: wechatOutbox.sentAt,
      createdAt: wechatOutbox.createdAt,
      lastError: wechatOutbox.lastError,
    })
    .from(wechatOutbox)
    .orderBy(asc(wechatOutbox.createdAt))
    .limit(limit);
}

/** 统计各状态数量，供线上自检与设置页 */
export async function outboxCounts(): Promise<Record<string, number>> {
  const rows = await db.execute<{ status: string; n: number }>(sql`
    SELECT status, count(*)::int AS n FROM wechat_outbox GROUP BY status
  `);
  const out: Record<string, number> = {};
  for (const r of rows.rows ?? []) out[r.status] = r.n;
  return out;
}

export { config };

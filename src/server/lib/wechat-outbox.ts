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
import { and, asc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { wechatOutbox } from '../db/schema';
import { ownedBy } from './scope';
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
  /**
   * 归属账号：这条回复最终要经**该用户自己的**微信凭据发出。
   * 入参必填（不是从 operationId 反查）：调用方本来就知道"在替谁回话"，
   * 让它显式写出来，漏传才会在编译期暴露，而不是运行期发错人。
   */
  userId: number;
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
      userId: input.userId,
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
  /** 归属账号：从 outbox 行上读出，发送侧据此取**该用户自己的**凭据与窗口 */
  userId: number;
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
/**
 * 领取待发送回复。
 *
 * `sendableUserIds` 是**可选**的：传入时只领取"所属账号当前可发送"的回复。
 * 生产路径（`worker/outbox-sender.ts`）必须传它——否则一批里会混进不可发送账号的
 * 回复，被领出来又只能原地交还，既浪费一轮批次，也可能把后面真正能发的回复饿死。
 * 不传时保持跨账号领取的旧行为（仅供维护/测试使用）。
 */
export async function claimOutboxBatch(
  limit = 3,
  now = new Date(),
  sendableUserIds?: number[],
): Promise<PendingReply[]> {
  // 传了集合但是空的 → 没有任何账号可发送，一条都不领（fail closed）
  if (sendableUserIds && sendableUserIds.length === 0) return [];

  // 逐个 id 作为独立参数绑定，避免把数组序列化成字符串（曾导致 malformed array literal）
  const userFilter = sendableUserIds
    ? sql` AND user_id IN (${sql.join(sendableUserIds.map((id) => sql`${id}`), sql`, `)})`
    : sql``;

  return db.transaction(async (tx) => {
    const claimed = await tx.execute<{ id: string }>(sql`
      SELECT id FROM wechat_outbox
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${now.toISOString()})
        AND attempts < max_attempts${userFilter}
      ORDER BY created_at ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);
    const ids = (claimed.rows ?? []).map((r) => r.id);
    if (ids.length === 0) return [];

    const leaseUntil = new Date(now.getTime() + OUTBOX_LEASE_MINUTES * 60_000);
    // 用 inArray 绑定参数。
    // 注意：不能写 `= ANY(${ids}::uuid[])`——pg 驱动会把 JS 数组序列化成
    // **单个字符串**而不是数组字面量，运行期报 "malformed array literal"。
    // 该写法曾在 inbox 的领取路径里留下同样的隐患（只是当时测试都在空集时提前返回）。
    const claimedWhere = inArray(wechatOutbox.id, ids);
    await tx
      .update(wechatOutbox)
      .set({ status: 'sending', leasedUntil: leaseUntil, attempts: sql`${wechatOutbox.attempts} + 1` })
      .where(claimedWhere);

    return tx
      .select({
        id: wechatOutbox.id,
        userId: wechatOutbox.userId,
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
      .where(inArray(wechatOutbox.id, ids))
      .orderBy(asc(wechatOutbox.createdAt));
  });
}

/**
 * 终态回执：用户必须知道的结果，**即使操作已结束也要送达**。
 * 相对的，`preview` 是"待确认"、`notice` 是"延期/无法发出"之类；
 * 操作结束后它们只会造成困惑（例如先收到「已创建」再收到矛盾的「待确认 XXX」）。
 */
const OUTCOME_REPLY_TYPES: ReadonlySet<string> = new Set(['created', 'cancelled', 'expired', 'error']);

/**
 * 发送前重新核对：代际是否仍是当前代际、草稿版本是否仍是最新、操作是否尚未结束。
 *
 * 这是"过时回复作废"的执行点：领取与发送之间可能发生换绑或草稿修改，
 * 所以**发送前**必须再查一次，而不是信任领取时的快照。
 *
 * ⚠️ 只比 `version` 是不够的：`commitOperation` **不递增版本**（它只改状态），
 * 因此一条**尚未发出的预览**在提交后仍然"版本匹配"，会被当成有效回复发出去——
 * 用户会先看到「已创建」，再收到一条矛盾的「待确认 XXX」。
 * 所以命中终态操作时，只有**终态回执**仍然发送，其余一律作废。
 *
 * `userId` 来自被领取的 outbox 行（该回复属于谁）。查操作时一并带上它：
 * 即使 operationId 被写错成别人的操作，也查不出来，宁可作废也不发出。
 */
export async function isReplyStillValid(reply: {
  userId: number;
  bindingGeneration: string;
  operationId: string | null;
  operationVersion: number | null;
  replyType?: string;
}): Promise<{ valid: boolean; reason: string | null }> {
  // 校验"该账号自己"的绑定是否仍然有效。
  // 改造前这里读的是 settings 里那行全局状态，而迁移 0004 已把它删除：
  // 若继续读 settings，`account` 恒为空 → 每一条回复都会被判成"尚未绑定"而 suppressed，
  // 表现为"提醒能发、回复全丢"，且没有任何报错。
  const rows = await db.execute<{ generation: string; account_enc: string | null }>(sql`
    SELECT generation, account_enc FROM wechat_accounts WHERE user_id = ${reply.userId}
  `);
  const row = rows.rows?.[0];
  if (!row?.account_enc) return { valid: false, reason: '尚未绑定微信，回复不发送' };
  if (row.generation !== reply.bindingGeneration) {
    return { valid: false, reason: '绑定已变更，旧回复作废' };
  }
  if (reply.operationId) {
    const opRows = await db.execute<{ version: number; status: string }>(sql`
      SELECT version, status FROM wechat_operations
      WHERE id = ${reply.operationId} AND user_id = ${reply.userId}
    `);
    const op = opRows.rows?.[0];
    if (op && reply.operationVersion !== null && op.version !== reply.operationVersion) {
      return { valid: false, reason: '草稿已被新版本替代，旧预览作废' };
    }
    // 操作已结束：终态回执必须送达（用户必须知道结果），其余回复作废
    const terminal = ['committed', 'cancelled', 'expired', 'invalidated'];
    const isOutcome = reply.replyType !== undefined && OUTCOME_REPLY_TYPES.has(reply.replyType);
    if (op && terminal.includes(op.status) && !isOutcome) {
      return {
        valid: false,
        reason: `操作已结束（${op.status}），该回复已过时，不再发送`,
      };
    }
  }
  return { valid: true, reason: null };
}

/**
 * 标记已发送。
 *
 * `userId` 来自被领取的 outbox 行；带上 `ownedBy` 使"改到别人的回复状态"不可能发生。
 */
export async function markOutboxSent(userId: number, id: string, now = new Date()): Promise<void> {
  await db
    .update(wechatOutbox)
    .set({ status: 'sent', sentAt: now, leasedUntil: null, nextAttemptAt: null, lastError: null })
    .where(and(eq(wechatOutbox.id, id), ownedBy(wechatOutbox, userId)));
}

/**
 * 作废（不发送）。用于过时回复：它是终态，不再重试，
 * 且**不计入已送达**，避免"以为发出去了"。
 */
export async function markOutboxSuppressed(userId: number, id: string, reason: string): Promise<void> {
  await db
    .update(wechatOutbox)
    .set({ status: 'suppressed', leasedUntil: null, nextAttemptAt: null, lastError: reason.slice(0, 500) })
    .where(and(eq(wechatOutbox.id, id), ownedBy(wechatOutbox, userId)));
}

/**
 * 发送失败：按三态处理（PRD 7.3）。
 * - `unknown`：HTTP 200 但无可靠回执、超时、发送中中断 → **绝不自动重发**；
 * - 明确可重试 → 退避重试；
 * - 明确拒绝/需人工介入 → 终止。
 */
export async function markOutboxFailed(
  userId: number,
  id: string,
  failureKind: 'retryable' | 'rejected' | 'needs_human' | 'unknown',
  error: string,
  now = new Date(),
): Promise<'pending' | 'failed'> {
  const [row] = await db
    .select({ attempts: wechatOutbox.attempts, maxAttempts: wechatOutbox.maxAttempts })
    .from(wechatOutbox)
    .where(and(eq(wechatOutbox.id, id), ownedBy(wechatOutbox, userId)))
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
      .where(and(eq(wechatOutbox.id, id), ownedBy(wechatOutbox, userId)));
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
    .where(and(eq(wechatOutbox.id, id), ownedBy(wechatOutbox, userId)));
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

/**
 * 供"最近操作"与设置页展示：**该账号**的最近回复。
 *
 * 必须按账号过滤：回复记录的正文（body）不在返回列里，但 replyType/status/lastError
 * 足以暴露"别人发过什么、失败原因是什么"。全库取最近 N 条会把这些混进来。
 */
export async function listRecentReplies(userId: number, limit = 10) {
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
    .where(ownedBy(wechatOutbox, userId))
    .orderBy(asc(wechatOutbox.createdAt))
    .limit(limit);
}

/** 统计各状态数量，供线上自检与设置页（按账号：见 listRecentReplies 的说明） */
export async function outboxCounts(userId: number): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: wechatOutbox.status, count: sql<number>`count(*)::int` })
    .from(wechatOutbox)
    .where(ownedBy(wechatOutbox, userId))
    .groupBy(wechatOutbox.status);

  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.count;
  return out;
}

export { config };

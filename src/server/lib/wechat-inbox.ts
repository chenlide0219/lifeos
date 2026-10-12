/**
 * 入站消息持久化与处理队列（PRD 7.1、8.1）。
 *
 * 为什么必须重构原来的接收侧：
 * 原 `pollWechatUpdates()` 在**同步**的 `updateWechatState(fn)` 回调里更新上下文，
 * 该回调运行在一个已开启的事务中，因此无法在其中调用模型或另一个连接。
 * 若把模型调用塞进去就会长时间占着事务；若放到回调外又会丢掉"消息与游标原子提交"。
 *
 * 现在的结构（三层，各自只做一件事）：
 *   1. `persistInbound`：网络轮询之后，**在一个短事务里**完成
 *      "插入 inbox（幂等）+ 推进游标 + 刷新上下文"。只有数据库操作，没有网络调用。
 *   2. `claimInboxBatch`：事务外按租约领取待处理消息（可被崩溃回收）。
 *   3. `markInboxDone/Failed`：处理结束后回写终态与退避。
 *
 * 关键不变量：
 * - 同一 `(binding_generation, provider_message_id)` 只入库一次：去重靠数据库唯一约束，
 *   不靠内存 `seen` 数组（重启即失忆，且长度有限会漏判）。
 * - `parse_basis_at` 在**入站那一刻**冻结：重试不得用新的"现在"重新解释"明天"（PRD 5）。
 * - 绑定代际变化后，旧代际的消息不再被领取（换绑即作废）。
 */
import crypto from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { wechatInbox } from '../db/schema';
import { seal, type WechatState } from './wechat-state';

/** 入站消息的最小结构（已从 iLink 载荷中过滤/归一化） */
export type InboundMessage = {
  /** 提供方消息 ID；缺失或重复时由内容派生，见 deriveProviderMessageId */
  providerMessageId: string | null;
  fromUserId: string;
  messageType: number;
  text: string;
  contextToken: string | null;
  /** 提供方时间（毫秒 epoch）；0 或缺失表示未知 */
  providerTimeMs: number;
  /** 内容指纹，用于提供方 ID 缺失时的兜底 */
  fingerprint: string;
};

/**
 * 派生稳定的去重 ID。
 *
 * 优先用提供方 ID；缺失时退化到内容指纹 + 提供方时间。
 * **不能只用内容哈希**：PRD 3 明确"相同文字的新消息不能仅凭文本相同就认定为重复投递"，
 * 所以兜底键必须把时间也算进去——同一句话在不同时刻是两条合法消息。
 */
export function deriveProviderMessageId(message: InboundMessage, generation: string): string {
  if (message.providerMessageId && message.providerMessageId.trim()) {
    return `id:${message.providerMessageId.trim()}`;
  }
  const basis = `${generation}\u0000${message.fromUserId}\u0000${message.providerTimeMs}\u0000${message.fingerprint}`;
  return `fp:${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 32)}`;
}

/** 内容指纹：不含时间，供上层构造 fingerprint 字段 */
export function fingerprintOf(text: string): string {
  return crypto.createHash('sha256').update(text.trim()).digest('hex');
}

export type PersistResult = {
  /** 真正新入库的消息数（被去重挡下的不计） */
  inserted: number;
  /** 去重命中的条数 */
  duplicated: number;
};

export type PersistInput = {
  generation: string;
  messages: InboundMessage[];
  /** 入站时刻；同时作为所有新消息的解析基准 */
  receivedAt: Date;
  /** 本轮游标（来自 get_updates_buf）；为 null 表示不推进 */
  cursor: string | null;
  /** 命中有效消息时刷新的上下文 token（明文，入库前加密） */
  context: { token: string; at: Date; providerTimeMs: number } | null;
  /** 绑定用户的用户 ID，用于过滤 */
  boundUserId: string;
};

/** 单条消息的持久化结果，供上层决定是否触发处理 */
export type PersistedMessage = { id: string; text: string; parseBasisAt: Date; operationId: string | null };

export const BODY_RETENTION_DAYS = Number(process.env.WECHAT_BODY_RETENTION_DAYS ?? 7);
export const INBOX_LEASE_MINUTES = Number(process.env.WECHAT_INBOX_LEASE_MINUTES ?? 5);
export const INBOX_MAX_ATTEMPTS = Number(process.env.WECHAT_INBOX_MAX_ATTEMPTS ?? 3);

function purgeAfterFrom(now: Date): Date {
  return new Date(now.getTime() + BODY_RETENTION_DAYS * 86_400_000);
}

/**
 * 把一批入站消息与游标/上下文在**同一事务**内提交。
 *
 * 只看绑定用户本人的文本消息（PRD 4.1 第 1 条：校验代际、发送人与消息类型，
 * 过滤机器人回声）；其余消息只推进游标，不入库、不触发业务。
 */
export async function persistInbound(input: PersistInput): Promise<PersistResult> {
  const purgeAfter = purgeAfterFrom(input.receivedAt);
  let inserted = 0;
  let duplicated = 0;

  await db.transaction(async (tx) => {
    // 凭证快照与内容一并更新；游标必须与消息同事务，否则崩溃会出现
    // "游标已推进但消息丢失"（消息永久丢失）或"消息重复但游标未动"。
    await tx.execute(sql`
      INSERT INTO settings(key, value) VALUES ('wechat.private-channel', '{}'::jsonb)
      ON CONFLICT DO NOTHING
    `);
    const locked = await tx.execute<{ value: WechatState }>(sql`
      SELECT value FROM settings WHERE key = 'wechat.private-channel' FOR UPDATE
    `);
    const state = (locked.rows?.[0]?.value ?? null) as WechatState | null;
    if (!state) return;

    // 绑定代际在轮询期间若已变化（换绑/解绑），本批消息一律丢弃
    if (state.generation !== input.generation) return;

    for (const message of input.messages) {
      if (message.messageType !== 1) continue;
      if (message.fromUserId !== input.boundUserId) continue;
      if (!message.text.trim()) continue;

      const providerMessageId = deriveProviderMessageId(message, input.generation);
      const rows = await tx
        .insert(wechatInbox)
        .values({
          bindingGeneration: input.generation,
          providerMessageId,
          fromUserId: message.fromUserId,
          messageType: message.messageType,
          text: message.text,
          contextTokenEnc: message.contextToken ? seal(message.contextToken) : null,
          receivedAt: input.receivedAt,
          providerTime: message.providerTimeMs > 0 ? new Date(message.providerTimeMs) : null,
          parseBasisAt: input.receivedAt,
          status: 'pending',
          purgeAfter,
        })
        // 唯一约束挡下重复投递；DO NOTHING 让重复成为无副作用的成功
        .onConflictDoNothing({ target: [wechatInbox.bindingGeneration, wechatInbox.providerMessageId] })
        .returning({ id: wechatInbox.id });

      if (rows.length > 0) inserted += 1;
      else duplicated += 1;
    }

    // 游标与上下文一并推进（与消息同事务）
    if (input.cursor) state.cursor = input.cursor;
    if (input.context) {
      state.context = seal(input.context.token);
      state.revision = crypto.randomUUID();
      state.refreshedAt = input.context.at.getTime();
      state.lastInboundTime = Math.max(state.lastInboundTime, input.context.providerTimeMs);
      state.used = 0;
      state.accepted = 0;
      state.failed = 0;
      state.unknown = 0;
      state.warned = false;
      state.warningResult = null;
      // 一条消息可以续期上下文，但不能让已过期的机器人登录复活
      if (state.pausedReason !== 'login_expired') state.pausedReason = null;
    }
    state.listenerAt = input.receivedAt.getTime();
    state.listenerError = null;

    await tx.execute(sql`
      UPDATE settings SET value = ${JSON.stringify(state)}::jsonb, updated_at = now()
      WHERE key = 'wechat.private-channel'
    `);
  });

  return { inserted, duplicated };
}

/** 当前绑定代际；未绑定时返回 null（上层据此跳过处理） */
export async function currentBindingGeneration(): Promise<string | null> {
  const rows = await db.execute<{ value: WechatState }>(sql`
    SELECT value FROM settings WHERE key = 'wechat.private-channel'
  `);
  const state = (rows.rows?.[0]?.value ?? null) as WechatState | null;
  if (!state?.account) return null;
  return state.generation ?? null;
}

export type ClaimedMessage = {
  id: string;
  bindingGeneration: string;
  text: string;
  parseBasisAt: Date;
  attempts: number;
  maxAttempts: number;
  contextTokenEnc: string | null;
};

/**
 * 领取待处理消息（事务外，短事务）。
 *
 * 租约语义：`leased_until` 到期后可被重新领取，因此进程崩溃不会让消息永久卡死；
 * 领取时把状态置为 processing，避免同一批被并发处理两次。
 */
export async function claimInboxBatch(limit = 5, now = new Date()): Promise<ClaimedMessage[]> {
  return db.transaction(async (tx) => {
    // SKIP LOCKED：多实例/多轮并发时各领各的，不互相阻塞
    const claimed = await tx.execute<{ id: string }>(sql`
      SELECT id FROM wechat_inbox
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${now.toISOString()})
        AND attempts < max_attempts
      ORDER BY received_at ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);
    const ids = (claimed.rows ?? []).map((r) => r.id);
    if (ids.length === 0) return [];

    const leaseUntil = new Date(now.getTime() + INBOX_LEASE_MINUTES * 60_000);
    // 用绑定参数传 uuid[]，不拼接 SQL 字符串
    await tx
      .update(wechatInbox)
      .set({ status: 'processing', leasedUntil: leaseUntil, attempts: sql`${wechatInbox.attempts} + 1` })
      .where(inArray(wechatInbox.id, ids));

    const rows = await tx
      .select({
        id: wechatInbox.id,
        bindingGeneration: wechatInbox.bindingGeneration,
        text: wechatInbox.text,
        parseBasisAt: wechatInbox.parseBasisAt,
        attempts: wechatInbox.attempts,
        maxAttempts: wechatInbox.maxAttempts,
        contextTokenEnc: wechatInbox.contextTokenEnc,
      })
      .from(wechatInbox)
      .where(inArray(wechatInbox.id, ids))
      .orderBy(asc(wechatInbox.receivedAt));

    return rows;
  });
}

/** 处理成功：终态 done，清理租约，只清正文之外的状态 */
export async function markInboxDone(id: string, operationId: string | null = null): Promise<void> {
  await db
    .update(wechatInbox)
    .set({
      status: 'done',
      leasedUntil: null,
      nextAttemptAt: null,
      lastError: null,
      operationId,
      processedAt: new Date(),
    })
    .where(eq(wechatInbox.id, id));
}

/**
 * 处理失败：按剩余次数退避重试，耗尽后进入 dead 终态。
 * `dead` 的消息**不会阻塞后续消息**（PRD 7.1：坏消息不能永久堵住队列）。
 */
export async function markInboxFailed(id: string, error: string, now = new Date()): Promise<'pending' | 'dead'> {
  const [row] = await db
    .select({ attempts: wechatInbox.attempts, maxAttempts: wechatInbox.maxAttempts })
    .from(wechatInbox)
    .where(eq(wechatInbox.id, id))
    .limit(1);
  if (!row) return 'dead';

  const exhausted = row.attempts >= row.maxAttempts;
  if (exhausted) {
    await db
      .update(wechatInbox)
      .set({ status: 'dead', leasedUntil: null, nextAttemptAt: null, lastError: error.slice(0, 500), processedAt: now })
      .where(eq(wechatInbox.id, id));
    return 'dead';
  }

  // 退避：attempts 已包含本次，因此第 1 次失败后等 1 分钟，之后 5、15 分钟
  const backoffMinutes = [1, 5, 15][Math.min(row.attempts - 1, 2)] ?? 15;
  await db
    .update(wechatInbox)
    .set({
      status: 'pending',
      leasedUntil: null,
      nextAttemptAt: new Date(now.getTime() + backoffMinutes * 60_000),
      lastError: error.slice(0, 500),
    })
    .where(eq(wechatInbox.id, id));
  return 'pending';
}

/**
 * 回收超租约的 processing 记录。
 *
 * 必须覆盖两种情形，缺一不可：
 *   1. `leased_until` 已过期 → 正常超时；
 *   2. `leased_until IS NULL` 且已超过一个租约时长 → **进程在"置 processing"
 *      与"写租约"之间被杀**留下的行。
 *      注意 `lt(NULL, now)` 在 SQL 里是 NULL（不成立），只写第 1 条会让这类行
 *      **永久停留在 processing**、再也不会被领取——消息静默卡死。
 *      这正是"领取时先把状态置为 processing、再单独写租约"这个两段式的固有窗口。
 *
 * 之所以用 `received_at` 兜底而不是只看 NULL：极旧且租约为 NULL 的行也需要被清掉，
 * 而新入库尚未领取的行状态是 `pending`，不会被这条谓词命中。
 */
export async function reclaimExpiredLeases(now = new Date()): Promise<number> {
  const graceCutoff = new Date(now.getTime() - INBOX_LEASE_MINUTES * 60_000);
  const rows = await db
    .update(wechatInbox)
    .set({ status: 'pending', leasedUntil: null })
    .where(
      and(
        eq(wechatInbox.status, 'processing'),
        or(
          // 正常超时
          and(isNotNull(wechatInbox.leasedUntil), lt(wechatInbox.leasedUntil, now)),
          // 崩溃窗口：租约从未写入
          and(isNull(wechatInbox.leasedUntil), lt(wechatInbox.receivedAt, graceCutoff)),
        ),
      ),
    )
    .returning({ id: wechatInbox.id });
  return rows.length;
}

/**
 * 正文保留期清理（PRD 16.1-4）：到期只把**正文**抹掉，
 * 保留去重键、终态与操作关联，避免破坏幂等与"最近操作"核实能力。
 */
export async function purgeExpiredBodies(now = new Date()): Promise<{ inbox: number; outbox: number }> {
  const inboxRows = await db.execute(sql`
    UPDATE wechat_inbox SET text = ''
    WHERE purge_after IS NOT NULL AND purge_after <= ${now.toISOString()} AND text <> ''
  `);
  const outboxRows = await db.execute(sql`
    UPDATE wechat_outbox SET body = ''
    WHERE purge_after IS NOT NULL AND purge_after <= ${now.toISOString()} AND body <> ''
  `);
  return {
    inbox: (inboxRows as unknown as { rowCount?: number }).rowCount ?? 0,
    outbox: (outboxRows as unknown as { rowCount?: number }).rowCount ?? 0,
  };
}

/** 供界面/诊断：最近入站统计 */
export async function inboxCounts(): Promise<Record<string, number>> {
  const rows = await db.execute<{ status: string; n: number }>(sql`
    SELECT status, count(*)::int AS n FROM wechat_inbox GROUP BY status
  `);
  const out: Record<string, number> = {};
  for (const r of rows.rows ?? []) out[r.status] = r.n;
  return out;
}

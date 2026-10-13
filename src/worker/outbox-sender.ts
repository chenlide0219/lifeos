/**
 * 微信回复发送器（PRD 7.3，多用户版）。
 *
 * 与提醒发送的关系：
 *   - 提醒走 `notification_jobs` + `core.tick()`；
 *   - 回复走 `wechat_outbox` + 本模块；
 *   两者**共用同一个 provider**，因此共用同一套 8/10 窗口计数与凭据
 *   （PRD 16.2：窗口计数沿用既有实现，不另立第二套计数）。
 *
 * 多用户下最关键的约束：**凭据与发送窗口取自该条 outbox 行自己的 `user_id`**。
 * 行的 `userId` 是唯一可信来源——不从 `binding_generation` 反查，也不从"当前唯一绑定"
 * 推断；一条回复所属账号不可发送时，只跳过它自己，绝不影响其他账号的回复。
 *
 * 发送前必须重新校验"这条回复是否还有效"：
 * 领取与发送之间可能发生换绑、草稿被修改或被替代，
 * 过时的预览/回复**必须作废**而不是迟到送达（PRD 7.3）。
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../server/db/client';
import { wechatOutbox } from '../server/db/schema';
import { ownedBy } from '../server/lib/scope';
import { canSendWechat, listBoundWechatAccounts } from '../server/lib/wechat-state';
import {
  claimOutboxBatch,
  isReplyStillValid,
  markOutboxFailed,
  markOutboxSent,
  markOutboxSuppressed,
  reclaimStaleSending,
  type PendingReply,
} from '../server/lib/wechat-outbox';
import { getProvider, refreshProviders } from './registry';

export type OutboxSendResult = {
  claimed: number;
  sent: number;
  suppressed: number;
  retried: number;
  failed: number;
  deferred: number;
  reclaimed: number;
};

/**
 * 归属账号暂不可发送时，把该回复压后多久再看。
 *
 * 需要一个非零的压后时间：领取是按 `created_at` 排序的**跨账号**查询，
 * 若交还后立刻又可领取，每轮都会重新领到同一批不可发送的回复，
 * 把它们后面的回复**饿死**。
 */
const RELEASE_BACKOFF_MS = 60_000;

/**
 * 把"已领取、但所属账号当前不可发送"的回复交还 pending。
 *
 * 领取接口现在会按 `sendableUserIds` 过滤（见下面的调用），因此这条路径**不再是常态**，
 * 只用于处理"领取之后、发送之前账号被暂停"的竞态。保留它的理由：
 * 这种回复若走 `markOutboxFailed` 会把 `attempts` 留在 +1 上，连续几轮就可能把一条
 * 本可正常发出的回复判成"重试耗尽"。这里按 `ownedBy` 限定归属，只把 attempts 减回去。
 */
async function releaseOutboxReply(reply: PendingReply, now: Date): Promise<void> {
  await db
    .update(wechatOutbox)
    .set({
      status: 'pending',
      leasedUntil: null,
      nextAttemptAt: new Date(now.getTime() + RELEASE_BACKOFF_MS),
      attempts: sql`GREATEST(${wechatOutbox.attempts} - 1, 0)`,
    })
    .where(and(eq(wechatOutbox.id, reply.id), ownedBy(wechatOutbox, reply.userId)));
}

/**
 * 发送一轮待发回复。
 *
 * 渠道未配置（没有任何账号可发送）时**不领取**任何回复：不消费、不记尝试、不伪造送达
 * （与提醒侧同一政策，避免"看起来发了"）。
 */
export async function sendPendingReplies(
  limit = Number(process.env.WECHAT_OUTBOX_BATCH ?? 3),
  now = new Date(),
): Promise<OutboxSendResult> {
  const result: OutboxSendResult = {
    claimed: 0,
    sent: 0,
    suppressed: 0,
    retried: 0,
    failed: 0,
    deferred: 0,
    reclaimed: 0,
  };

  // 发送中断遗留的 sending：结果未知，按策略不自动重发（跨账号维护动作，逐行自带 userId）
  result.reclaimed = await reclaimStaleSending(now);

  await refreshProviders();
  const provider = getProvider('wechat');
  if (!provider) return result;

  // 逐账号判定可发送性（与 core.tick 同一口径：已绑定 + 未暂停 + 上下文就绪）。
  // 注意这**不是**全局闸门：它只决定"这一轮要不要领取"，
  // 每条回复最终仍按自己行上的 userId 判定与发送。
  const accounts = await listBoundWechatAccounts();
  const sendable = new Set(accounts.filter(canSendWechat).map((account) => account.userId));

  // 一个账号都不可发送时绝不领取：不消费、不记尝试、不伪造送达
  if (sendable.size === 0) return result;

  const pending = await claimOutboxBatch(limit, now, [...sendable]);
  result.claimed = pending.length;

  for (const reply of pending) {
    // ── 过时作废优先于"账号当前能不能发" ──
    // 换绑/版本变化是**终态**：若因为该账号暂时不可发送而压后，
    // 这些回复会一直挂在 pending 上，永远等不到应有的作废。
    // 发送前复核：代际未变、草稿版本仍最新、且操作尚未结束（按行自己的 userId 校验）
    const validity = await isReplyStillValid({
      userId: reply.userId,
      bindingGeneration: reply.bindingGeneration,
      operationId: reply.operationId,
      operationVersion: reply.operationVersion,
      replyType: reply.replyType,
    });
    if (!validity.valid) {
      await markOutboxSuppressed(reply.userId, reply.id, validity.reason ?? '回复已失效');
      result.suppressed += 1;
      continue;
    }

    // 正文为空（已被保留期清理）不得发送，否则会发出一条空消息
    if (!reply.body.trim()) {
      await markOutboxSuppressed(reply.userId, reply.id, '正文已过期清理，不再发送');
      result.suppressed += 1;
      continue;
    }

    // 该条回复所属账号当前不可发送（窗口暂停 / 等上下文 / 登录过期）：
    // 只跳过这一条，交还 pending 且不消耗尝试次数——绝不借用其他账号的凭据代发。
    if (!sendable.has(reply.userId)) {
      await releaseOutboxReply(reply, now);
      result.deferred += 1;
      continue;
    }

    const outcome = await provider.send({
      jobId: reply.id,
      // 发送方据此解析**该行账号自己**的凭据与 8/10 窗口
      userId: reply.userId,
      title: '',
      body: reply.body,
      subjectType: 'wechat_reply',
      subjectId: reply.operationId ?? reply.id,
      // 幂等键用去重键派生，重试携带同一标识避免下游重复
      idempotencyKey: reply.dedupeKey,
    });

    if (outcome.ok) {
      await markOutboxSent(reply.userId, reply.id, now);
      result.sent += 1;
      continue;
    }

    if (outcome.kind === 'deferred') {
      // 渠道暂时不可发送（未绑定/窗口满/缺上下文）：
      // 留在 pending，不计为失败，也不伪造送达（退避由 retryable 分支给出）
      await markOutboxFailed(reply.userId, reply.id, 'retryable', outcome.error, now);
      result.deferred += 1;
      continue;
    }

    const status = await markOutboxFailed(reply.userId, reply.id, outcome.kind, outcome.error, now);
    if (status === 'pending') result.retried += 1;
    else result.failed += 1;
  }

  return result;
}

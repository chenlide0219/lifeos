/**
 * 微信回复发送器（PRD 7.3）。
 *
 * 与提醒发送的关系：
 *   - 提醒走 `notification_jobs` + `core.tick()`；
 *   - 回复走 `wechat_outbox` + 本模块；
 *   两者**共用同一个 provider**，因此共用同一套 8/10 窗口计数与凭据
 *   （PRD 16.2：窗口计数沿用既有实现，不另立第二套计数）。
 *
 * 发送前必须重新校验"这条回复是否还有效"：
 * 领取与发送之间可能发生换绑、草稿被修改或被替代，
 * 过时的预览/回复**必须作废**而不是迟到送达（PRD 7.3）。
 */
import { claimOutboxBatch, isReplyStillValid, markOutboxFailed, markOutboxSent, markOutboxSuppressed, reclaimStaleSending } from '../server/lib/wechat-outbox';
import { getProvider, hasConfiguredProvider, refreshProviders } from './registry';

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
 * 发送一轮待发回复。
 *
 * 渠道未配置时**不领取**任何回复：不消费、不记尝试、不伪造送达
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

  // 发送中断遗留的 sending：结果未知，按策略不自动重发
  result.reclaimed = await reclaimStaleSending(now);

  await refreshProviders();
  if (!hasConfiguredProvider()) return result;

  const provider = getProvider('wechat');
  if (!provider) return result;

  const pending = await claimOutboxBatch(limit, now);
  result.claimed = pending.length;

  for (const reply of pending) {
    // 发送前复核：代际未变、草稿版本仍是最新
    const validity = await isReplyStillValid({
      bindingGeneration: reply.bindingGeneration,
      operationId: reply.operationId,
      operationVersion: reply.operationVersion,
    });
    if (!validity.valid) {
      await markOutboxSuppressed(reply.id, validity.reason ?? '回复已失效');
      result.suppressed += 1;
      continue;
    }

    // 正文为空（已被保留期清理）不得发送，否则会发出一条空消息
    if (!reply.body.trim()) {
      await markOutboxSuppressed(reply.id, '正文已过期清理，不再发送');
      result.suppressed += 1;
      continue;
    }

    const outcome = await provider.send({
      jobId: reply.id,
      title: '',
      body: reply.body,
      subjectType: 'wechat_reply',
      subjectId: reply.operationId ?? reply.id,
      // 幂等键用去重键派生，重试携带同一标识避免下游重复
      idempotencyKey: reply.dedupeKey,
    });

    if (outcome.ok) {
      await markOutboxSent(reply.id, now);
      result.sent += 1;
      continue;
    }

    if (outcome.kind === 'deferred') {
      // 渠道暂时不可发送（未绑定/窗口满/缺上下文）：
      // 留在 pending，不计为失败，也不消耗重试次数之外的任何东西
      await markOutboxFailed(reply.id, 'retryable', outcome.error, now);
      result.deferred += 1;
      continue;
    }

    const status = await markOutboxFailed(reply.id, outcome.kind, outcome.error, now);
    if (status === 'pending') result.retried += 1;
    else result.failed += 1;
  }

  return result;
}

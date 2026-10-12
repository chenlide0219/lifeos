/**
 * 微信入站轮询（PRD 7.1）。
 *
 * 重构要点（这是接收侧的关键改动）：
 * 原实现在**同步**的 `updateWechatState(fn)` 回调里完成"去重 + 更新上下文"，
 * 而该回调运行在一个已开启的事务中。这意味着：
 *   1. 无法在其中调用模型或使用另一个连接（会长时间占着事务）；
 *   2. 去重依赖内存里的 `seen` 数组（截断 200 条），重启即失忆、超长会漏判。
 *
 * 现在的分工是三层，各自只做一件事：
 *   本文件（轮询）      → 取回消息，**只做持久化**（消息 + 游标 + 上下文同事务）；
 *   inbox-processor    → 事务外按租约领取并处理；
 *   wechat-handler     → 真正的业务路由与状态机。
 *
 * 本文件不包含任何业务判断：不解析意图、不调用模型、不写业务表。
 */
import { ilinkRequest } from '../server/lib/wechat-api';
import { unseal, updateWechatState, readWechatState, type WechatCredentials } from '../server/lib/wechat-state';
import { fingerprintOf, persistInbound, type InboundMessage } from '../server/lib/wechat-inbox';

export type PollOutcome = {
  /** 是否处于已绑定状态（未绑定时不轮询，也不算错误） */
  bound: boolean;
  /** 入库的新消息数 */
  inserted: number;
  /** 被去重挡下的条数 */
  duplicated: number;
  /** 上游返回的业务错误（已写入 listenerError） */
  upstreamError: string | null;
};

/** 上游业务错误码判定：ret/errcode 任一非 0 即为拒绝 */
export function upstreamErrorOf(data: Record<string, unknown>): string | null {
  const ret = data.ret;
  const errcode = data.errcode;
  const retBad = typeof ret === 'number' && ret !== 0;
  const codeBad = typeof errcode === 'number' && errcode !== 0;
  if (!retBad && !codeBad) return null;
  if (ret === -14 || errcode === -14) return '登录已过期';
  return '微信接收接口拒绝请求，请检查绑定状态';
}

/** 从 iLink 载荷里挑出候选消息（只做形状过滤，不做业务判断） */
export function collectMessages(data: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(data.msgs)) return [];
  return data.msgs
    .filter((m: unknown): m is Record<string, unknown> => Boolean(m && typeof m === 'object'))
    // 稳定排序：提供方时间相同的按 message_id 兜底，避免两次轮询顺序不同
    .sort((a, b) => {
      const ta = Number(a.create_time_ms ?? 0);
      const tb = Number(b.create_time_ms ?? 0);
      if (ta !== tb) return ta - tb;
      return String(a.message_id ?? '').localeCompare(String(b.message_id ?? ''));
    });
}

/** 把一条上游消息归一化成入站结构；非文本返回 null */
export function toInbound(message: Record<string, unknown>): InboundMessage | null {
  const messageType = Number(message.message_type ?? 0);
  if (messageType !== 1) return null;
  const fromUserId = typeof message.from_user_id === 'string' ? message.from_user_id : '';
  if (!fromUserId) return null;

  const text = extractTextFromMessage(message);
  if (!text) return null;

  const providerTimeMs = Number(message.create_time_ms ?? 0);
  const rawId = message.message_id ?? message.seq;
  const contextToken = typeof message.context_token === 'string' && message.context_token ? message.context_token : null;

  return {
    providerMessageId: rawId === undefined || rawId === null ? null : String(rawId),
    fromUserId,
    messageType,
    text,
    contextToken,
    // 提供方时间为 0 时用接收时刻兜底，保证"同文不同时"仍是两条消息
    providerTimeMs: providerTimeMs > 0 ? providerTimeMs : Date.now(),
    fingerprint: fingerprintOf(text),
  };
}

function extractTextFromMessage(message: Record<string, unknown>): string | null {
  const items = message.item_list;
  if (!Array.isArray(items)) return null;
  const parts: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (entry.type !== 1) continue;
    const textItem = entry.text_item;
    if (!textItem || typeof textItem !== 'object') continue;
    const text = (textItem as Record<string, unknown>).text;
    if (typeof text === 'string' && text.trim()) parts.push(text.trim());
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * 轮询一次。
 *
 * 事务内只做数据库操作；网络请求全部在事务之外完成。
 * 只有**绑定用户本人的文本消息**会刷新上下文（其余消息只推进游标）。
 */
export async function pollWechatUpdates(signal?: AbortSignal): Promise<PollOutcome> {
  const initial = await readWechatState();
  if (!initial.account) return { bound: false, inserted: 0, duplicated: 0, upstreamError: null };

  const account = unseal<WechatCredentials>(initial.account);
  const data = await ilinkRequest(account.baseUrl, 'ilink/bot/getupdates', {
    token: account.token,
    body: { get_updates_buf: initial.cursor, base_info: { channel_version: '0.1.0' } },
    signal,
    timeout: 30_000,
  });

  const upstreamError = upstreamErrorOf(data);
  if (upstreamError) {
    await updateWechatState((s) => {
      if (s.generation !== initial.generation || !s.account) return;
      s.listenerAt = Date.now();
      s.listenerError = upstreamError;
      if (upstreamError === '登录已过期') s.pausedReason = 'login_expired';
    });
    return { bound: true, inserted: 0, duplicated: 0, upstreamError };
  }

  const candidates = collectMessages(data);
  const inbound: InboundMessage[] = [];
  for (const candidate of candidates) {
    const message = toInbound(candidate);
    if (message) inbound.push(message);
  }

  // 上下文取**最后一条**有效消息的 token（时间已排序）
  const lastWithContext = [...inbound]
    .reverse()
    .find((m) => m.fromUserId === account.userId && m.contextToken);
  const cursor = typeof data.get_updates_buf === 'string' && data.get_updates_buf ? data.get_updates_buf : null;
  const receivedAt = new Date();

  const result = await persistInbound({
    generation: initial.generation,
    messages: inbound,
    receivedAt,
    cursor,
    context: lastWithContext?.contextToken
      ? { token: lastWithContext.contextToken, at: receivedAt, providerTimeMs: lastWithContext.providerTimeMs }
      : null,
    boundUserId: account.userId,
  });

  return { bound: true, inserted: result.inserted, duplicated: result.duplicated, upstreamError: null };
}

/** 监听循环：轮询 → 短暂停顿 → 再轮询。异常不终止循环，只记录状态。 */
export function startWechatListener(): () => Promise<void> {
  const controller = new AbortController();
  const pause = () =>
    new Promise<void>((resolve) => {
      if (controller.signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, 3000);
      controller.signal.addEventListener('abort', done, { once: true });
    });

  const running = (async () => {
    while (!controller.signal.aborted) {
      try {
        await pollWechatUpdates(controller.signal);
      } catch {
        if (!controller.signal.aborted) {
          await updateWechatState((s) => {
            s.listenerError = '微信接收连接异常，正在重试';
          }).catch(() => undefined);
        }
      }
      await pause();
    }
  })();

  return async () => {
    controller.abort();
    await running;
  };
}

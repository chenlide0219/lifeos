/**
 * 微信入站轮询（PRD 7.1，多用户版）。
 *
 * 多用户下的关键变化：**没有任何"全局绑定"了**。
 *   改造前这里只读一份全局状态、只轮询一个账号。现在必须遍历
 *   `listBoundWechatAccounts()` 拿到的**全部已绑定账号**，逐个轮询：
 *   每个账号用自己的 `cursor`（接收游标）、自己的 `generation`（绑定代际）、
 *   自己的 token，消息落到**该账号自己的 `user_id`** 名下。
 *   某个账号出错（登录过期、网络异常、凭据损坏）**只影响它自己**——
 *   一个账号的故障不能让其他账号停止接收。
 *
 * 三层分工（沿用既有结构，各自只做一件事）：
 *   本文件（轮询）      → 取回消息，**只做持久化**（消息 + 游标 + 上下文同事务）；
 *   inbox-processor    → 事务外按租约领取并处理；
 *   wechat-handler     → 真正的业务路由与状态机。
 *
 * 本文件不包含任何业务判断：不解析意图、不调用模型、不写业务表。
 * 此外它负责**周期性维护**：回收崩溃遗留的租约、按保留期清理正文。
 */
import { ilinkRequest } from '../server/lib/wechat-api';
import {
  listBoundWechatAccounts,
  unseal,
  updateWechatState,
  type WechatAccount,
  type WechatCredentials,
} from '../server/lib/wechat-state';
import {
  fingerprintOf,
  persistInbound,
  purgeExpiredBodies,
  reclaimExpiredLeases,
  type InboundMessage,
} from '../server/lib/wechat-inbox';
import { purgeExpiredOutboxBodies } from '../server/lib/wechat-outbox';
import { processInboxBatch } from '../server/lib/wechat-processor';
import { sendPendingReplies } from './outbox-sender';

/** 每轮处理多少条入站消息 */
const INBOX_BATCH_SIZE = Number(process.env.WECHAT_INBOX_BATCH ?? 5);

/** 单个账号一轮轮询的结果：异常被隔离在这里，不向上抛 */
export type AccountPollOutcome = {
  userId: number;
  /** 是否真的向上游发起了轮询（已绑定且凭据可解密） */
  polled: boolean;
  /** 入库的新消息数 */
  inserted: number;
  /** 被去重挡下的条数 */
  duplicated: number;
  /** 上游返回的业务错误（已写入该账号的 listenerError） */
  upstreamError: string | null;
  /** 本账号本轮抛出的异常（已隔离，不影响其他账号） */
  failure: string | null;
};

export type PollOutcome = {
  /** 已绑定并参与轮询的账号数 */
  accounts: number;
  /** 至少有一个账号被轮询（无任何绑定账号时为 false，不算错误） */
  bound: boolean;
  /** 本轮全部账号合计入库的新消息数 */
  inserted: number;
  /** 本轮全部账号合计被去重挡下的条数 */
  duplicated: number;
  /** 第一条上游业务错误（摘要）；逐账号明细见 perAccount */
  upstreamError: string | null;
  /** 逐账号异常摘要（形如「账号 #3：登录已过期」），供心跳日志与排查 */
  failures: string[];
  /** 逐账号明细 */
  perAccount: AccountPollOutcome[];
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

/**
 * 从消息载荷里取文本。
 *
 * 必须宽容：真实 iLink 文本消息的正文在 `item_list[].text_item.text`，
 * 但只认这一种形状太脆——上游字段一旦调整，消息会被**静默丢弃**，
 * 表现为"微信里发了但系统毫无反应"，这类故障极难排查。
 * 因此依次尝试若干合理形状，并支持 item 直接带 `text`。
 */
function extractTextFromMessage(message: Record<string, unknown>): string | null {
  const asText = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null;

  const items = message.item_list;
  if (Array.isArray(items)) {
    const parts: string[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      // item type 1 = 文本；缺少 type 时也尝试取值，避免整条消息被丢
      if (entry.type !== undefined && entry.type !== 1) continue;

      const textItem = entry.text_item;
      if (textItem && typeof textItem === 'object') {
        const fromItem = asText((textItem as Record<string, unknown>).text);
        if (fromItem) {
          parts.push(fromItem);
          continue;
        }
      }
      const direct = asText(entry.text);
      if (direct) parts.push(direct);
    }
    if (parts.length > 0) return parts.join('\n');
  }

  // 退化形状：正文直接放在顶层
  for (const key of ['text', 'content', 'msg_text']) {
    const found = asText(message[key]);
    if (found) return found;
  }
  return null;
}

/**
 * 记录**该账号自己**的接收侧错误。
 *
 * 必须带代际与"仍绑定"两道校验：轮询期间可能发生换绑/解绑，
 * 那时这条错误属于旧代际，不得写到新一轮绑定上（与改造前同一防线）。
 */
async function markListenerError(account: WechatAccount, message: string): Promise<void> {
  await updateWechatState(account.userId, (s) => {
    if (s.generation !== account.generation || !s.account) return;
    s.listenerError = message;
  });
}

/**
 * 轮询**一个账号**。
 *
 * 事务内只做数据库操作；网络请求全部在事务之外完成。
 * 只有**该账号绑定用户本人的文本消息**会刷新它自己的上下文（其余消息只推进游标）。
 * 抛出的异常由调用方按账号隔离。
 */
async function pollAccountUpdates(account: WechatAccount, signal?: AbortSignal): Promise<AccountPollOutcome> {
  const empty: AccountPollOutcome = {
    userId: account.userId,
    polled: false,
    inserted: 0,
    duplicated: 0,
    upstreamError: null,
    failure: null,
  };
  // listBoundWechatAccounts 只返回已绑定的行；这里是防御性检查
  if (!account.account) return empty;

  let credentials: WechatCredentials;
  try {
    credentials = unseal<WechatCredentials>(account.account);
  } catch {
    // 凭据损坏：只影响这个账号，且不向上游发请求（发了也只会被拒）
    await markListenerError(account, 'WECHAT_CREDENTIAL_ERROR: 凭据无法解密，请重新扫码绑定');
    return { ...empty, failure: '凭据无法解密，需重新扫码绑定' };
  }

  // 用**该账号自己的** token 与游标轮询（游标每账号独立推进）
  const data = await ilinkRequest(credentials.baseUrl, 'ilink/bot/getupdates', {
    token: credentials.token,
    body: { get_updates_buf: account.cursor, base_info: { channel_version: '0.1.0' } },
    signal,
    timeout: 30_000,
  });

  const upstreamError = upstreamErrorOf(data);
  if (upstreamError) {
    // 上游业务错误只暂停/标记**这个账号**：登录过期不影响其他账号的接收
    await updateWechatState(account.userId, (s) => {
      if (s.generation !== account.generation || !s.account) return;
      s.listenerAt = Date.now();
      s.listenerError = upstreamError;
      if (upstreamError === '登录已过期') s.pausedReason = 'login_expired';
    });
    return { ...empty, polled: true, upstreamError };
  }

  const candidates = collectMessages(data);
  const inbound: InboundMessage[] = [];
  // 绑定用户发来的文本消息若提取不到正文，说明上游载荷形状与预期不符。
  // 这种消息会被丢弃，但**必须留下痕迹**：否则表现为"微信里发了、系统毫无反应"，
  // 是最难排查的一类故障。
  let unparsableText = 0;
  for (const candidate of candidates) {
    const isTextFromBoundUser =
      Number(candidate.message_type ?? 0) === 1 && candidate.from_user_id === credentials.userId;
    const message = toInbound(candidate);
    if (message) {
      inbound.push(message);
    } else if (isTextFromBoundUser) {
      unparsableText += 1;
    }
  }

  // 上下文取**最后一条**有效消息的 token（时间已排序）
  const lastWithContext = [...inbound].reverse().find((m) => m.fromUserId === credentials.userId && m.contextToken);
  const cursor = typeof data.get_updates_buf === 'string' && data.get_updates_buf ? data.get_updates_buf : null;
  const receivedAt = new Date();

  // 消息与"该账号的游标 + 上下文"在同一事务内提交，并且带上归属账号：
  // 入站侧是唯一能确定归属的地方，后续处理链只从行上读 userId
  const result = await persistInbound({
    userId: account.userId,
    generation: account.generation,
    messages: inbound,
    receivedAt,
    cursor,
    context: lastWithContext?.contextToken
      ? { token: lastWithContext.contextToken, at: receivedAt, providerTimeMs: lastWithContext.providerTimeMs }
      : null,
    boundUserId: credentials.userId,
  });

  if (unparsableText > 0) {
    await updateWechatState(account.userId, (s) => {
      if (s.generation !== account.generation || !s.account) return;
      s.listenerError = `收到 ${unparsableText} 条无法解析正文的文本消息，可能上游载荷格式有变化`;
    });
  }

  return {
    ...empty,
    polled: true,
    inserted: result.inserted,
    duplicated: result.duplicated,
    upstreamError: unparsableText > 0 ? `有 ${unparsableText} 条文本消息无法解析正文` : null,
  };
}

/**
 * 轮询一次**所有已绑定账号**。
 *
 * 单账号失败在这里被隔离：网络异常/上游错误只记在该账号自己的状态上，
 * 循环继续处理下一个账号。因此一个账号登录过期不会让别人的提醒停止接收。
 */
export async function pollWechatUpdates(signal?: AbortSignal): Promise<PollOutcome> {
  const accounts = await listBoundWechatAccounts();
  const outcome: PollOutcome = {
    accounts: accounts.length,
    bound: accounts.length > 0,
    inserted: 0,
    duplicated: 0,
    upstreamError: null,
    failures: [],
    perAccount: [],
  };

  for (const account of accounts) {
    let per: AccountPollOutcome;
    try {
      per = await pollAccountUpdates(account, signal);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      per = {
        userId: account.userId,
        polled: true,
        inserted: 0,
        duplicated: 0,
        upstreamError: null,
        failure: message,
      };
      await markListenerError(account, '微信接收连接异常，正在重试').catch(() => undefined);
    }

    outcome.perAccount.push(per);
    outcome.inserted += per.inserted;
    outcome.duplicated += per.duplicated;
    if (!outcome.upstreamError && per.upstreamError) outcome.upstreamError = per.upstreamError;
    const problem = per.failure ?? per.upstreamError;
    if (problem) outcome.failures.push(`账号 #${account.userId}：${problem}`);
  }

  return outcome;
}

/**
 * 监听循环：轮询 → 处理入站 → 发送回复 → 短暂停顿 → 再轮询。
 *
 * 顺序很重要：**先持久化再处理**。因此即使进程在处理中途被杀，
 * 消息仍留在 inbox 里可由租约回收重放，不会丢。
 * 异常不终止循环，只记录状态——单条坏消息不能停掉整个接收。
 */
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
    // 心跳：接收循环本身没有日志，出问题时无法从日志判断"到底在不在轮询"。
    // 每 5 分钟打一条摘要（含逐账号异常），便于真机排查。
    const HEARTBEAT_MS = 5 * 60_000;
    /** 维护任务（租约回收 + 正文清理）间隔；不必每轮都做 */
    const MAINTENANCE_MS = 10 * 60_000;
    let lastHeartbeat = 0;
    let lastMaintenance = 0;
    let maintenanceRounds = 0;
    let rounds = 0;
    let insertedTotal = 0;

    while (!controller.signal.aborted) {
      try {
        const outcome = await pollWechatUpdates(controller.signal);
        rounds += 1;
        insertedTotal += outcome.inserted;
        if (!outcome.bound) {
          if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
            lastHeartbeat = Date.now();
            console.log('[worker] 微信接收：没有任何账号绑定微信，未轮询');
          }
        } else if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
          lastHeartbeat = Date.now();
          // 逐账号异常必须出现在心跳里：否则"某个账号一直收不到消息"
          // 在日志上表现为一切正常，只能靠翻库发现。
          const problems = outcome.failures.length > 0 ? `；${outcome.failures.join('；')}` : '';
          console.log(
            `[worker] 微信接收心跳：已绑定 ${outcome.accounts} 个账号，${rounds} 轮新增入站 ${insertedTotal} 条${problems}`,
          );
          rounds = 0;
          insertedTotal = 0;
        }
      } catch (err) {
        // 这一层只兜住"连账号列表都拿不到"之类的整体失败（逐账号错误已在
        // pollWechatUpdates 内按账号记录到各自的 listenerError 上）。
        if (!controller.signal.aborted) {
          console.error('[worker] 微信接收轮询异常（本轮跳过，下一轮重试）:', (err as Error).message);
        }
      }

      // 处理与发送都在轮询之外：模型调用与网络发送不得持有数据库事务
      try {
        await processInboxBatch(INBOX_BATCH_SIZE);
      } catch (err) {
        console.error('[worker] 入站处理异常:', (err as Error).message);
      }

      try {
        await sendPendingReplies();
      } catch (err) {
        console.error('[worker] 回复发送异常:', (err as Error).message);
      }

      // 周期性维护：回收崩溃遗留的租约 + 按保留期清理正文。
      // 这两件事原先只写在模块里、**没有任何调用者**，等于没有生效：
      // 正文会无限增长，而崩溃在"置 processing"与"写租约"之间的消息会永久卡死。
      if (Date.now() - lastMaintenance > MAINTENANCE_MS) {
        lastMaintenance = Date.now();
        try {
          const reclaimed = await reclaimExpiredLeases();
          const purged = await purgeExpiredBodies();
          const purgedOutbox = await purgeExpiredOutboxBodies();
          maintenanceRounds += 1;
          // 无论是否有变化都留痕：否则"维护还在不在跑"只能靠推测，
          // 而它静默停止时不会有任何症状，直到表无限增长或消息卡死。
          if (reclaimed > 0 || purged.inbox > 0 || purgedOutbox > 0) {
            console.log(
              `[worker] 维护（第 ${maintenanceRounds} 轮）：回收租约 ${reclaimed} 条，清理正文 inbox ${purged.inbox} / outbox ${purgedOutbox} 条`,
            );
          } else if (maintenanceRounds === 1 || maintenanceRounds % 12 === 0) {
            // 首次与之后每约 2 小时记一次（10 分钟 × 12），避免每分钟刷屏
            console.log(`[worker] 维护（第 ${maintenanceRounds} 轮）：无待回收或待清理记录`);
          }
        } catch (err) {
          console.error('[worker] 维护任务异常:', (err as Error).message);
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

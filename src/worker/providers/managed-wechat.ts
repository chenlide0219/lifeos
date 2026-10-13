/**
 * 微信发送适配器：**逐账号**解析凭据与 8/10 发送窗口（多用户改造）。
 *
 * 为什么这里必须按账号工作：
 *   改造前全系统只有一份绑定（`settings` 里的一行），因此 provider 内部缓存
 *   "那一份状态"就够了。多用户下这么做会直接造成两类严重问题：
 *     1. **跨账号泄露**：只要 B 绑定了微信，A 的提醒就会被用 B 的凭据发出去；
 *     2. **互相干扰**：B 的窗口用尽会连带把 A 的发送暂停掉。
 *   所以一切"能不能发、还剩几次、发到哪个 token"都只从
 *   `wechat_accounts.user_id = payload.userId` 那一行取，**绝不借用别人的绑定**。
 *
 * 环境变量（`ILINK_TOKEN` 等）的全局发送路径**已被移除**：一个全局凭据无法归属到
 * 任何账号，留着它就等于又开了一个"用别人的微信发出去"的入口。
 * `IlinkWechatProvider` 类本身仍保留 `process.env.ILINK_*` 兜底（协议层测试在用），
 * 但本适配器只把**该账号自己的凭据**显式传给它。
 *
 * 三段式（沿用既有语义，只加了账号维度）：
 *   预约（`used += needed`、`unknown += needed`、可能置 `pausedReason`）
 *   → 提交事务 → 发网络请求 → 新事务按 `revision` 回填结果。
 *   **发送网络请求期间绝不持有数据库事务。**
 */
import type { NotificationJobPayload, NotificationProvider, ProviderStatus, SendResult } from '../provider';
import { IlinkWechatProvider, chunkText, type ChunkOutcome } from './ilink';
import {
  PAUSE_AT,
  WARN_AT,
  canSendWechat,
  listBoundWechatAccounts,
  readWechatState,
  unseal,
  updateWechatState,
  type WechatAccount,
  type WechatCredentials,
} from '../../server/lib/wechat-state';

/** 预约结果：三种去向必须分开，才能给出正确的失败种类（deferred 不计尝试） */
type Reservation =
  | {
      kind: 'ok';
      revision: string;
      credentials: WechatCredentials & { contextToken: string };
      warning: boolean;
      normalUsed: number;
    }
  /** 该账号没有绑定：不退回任何全局凭据，保留待发等用户扫码 */
  | { kind: 'unbound' }
  /** 绑定了但当前不可发（等上下文 / 窗口暂停 / 凭据损坏）：延后，不计为失败 */
  | { kind: 'deferred'; reason: string };

/**
 * 一个账号卡在什么状态（给管理员看的中文短句）。
 *
 * 必须逐账号说清楚：**没绑微信**、绑了但上下文未就绪、窗口用尽、登录过期，
 * 是完全不同的处置线索，混成一句"通道不可用"会让人往错误方向排查。
 */
function accountStateLabel(account: WechatAccount): string {
  if (!account.account) return '未绑定微信';
  try {
    unseal<WechatCredentials>(account.account);
  } catch {
    return '凭据无法解密，需重新扫码绑定';
  }
  if (canSendWechat(account)) return `可发送（本轮已用 ${account.used}/${PAUSE_AT}）`;
  if (account.pausedReason === 'login_expired') return '登录已过期，需重新扫码绑定';
  if (account.pausedReason === 'context_rejected') return '上下文被上游拒绝，请回复消息或发送 /refresh-context';
  if (!account.context) return '等待上下文（请向机器人发送一句话）';
  if (account.used >= PAUSE_AT) return `发送窗口已用尽（${account.used}/${PAUSE_AT}），请回复消息刷新`;
  return `发送已暂停（${account.pausedReason ?? '未知原因'}）`;
}

export class ManagedWechatProvider implements NotificationProvider {
  readonly channel = 'wechat';
  readonly name = '微信（iLink 发送通道）';

  /**
   * 已绑定账号的快照（`refresh()` 填充）。
   * 一切"渠道是否可用"只依据它——不再看环境变量。
   */
  private accounts: WechatAccount[] = [];
  private lastReachable: boolean | null = null;
  private lastProbedAt: string | null = null;

  async refresh(): Promise<void> {
    this.accounts = await listBoundWechatAccounts();
  }

  /** 已绑定账号数（启动横幅与状态页据此展示） */
  boundCount(): number {
    return this.accounts.length;
  }

  /**
   * 当前可发送的账号 id。
   *
   * ⚠️ 这里**不是**全局闸门：真正的领取资格由 `core.ts` 逐账号判定，
   * 这个列表只是让"回复发送器"与"状态展示"复用同一份口径。
   */
  sendableUserIds(): number[] {
    return this.accounts.filter((account) => canSendWechat(account)).map((account) => account.userId);
  }

  /** 逐账号状态摘要（启动横幅用：已绑定几个、其中几个可发送、各自卡在哪） */
  accountStates(): { userId: number; sendable: boolean; label: string }[] {
    return this.accounts.map((account) => ({
      userId: account.userId,
      sendable: canSendWechat(account),
      label: accountStateLabel(account),
    }));
  }

  /** 至少有一个账号已绑定（不再包含环境变量凭据） */
  isConfigured(): boolean {
    return this.accounts.length > 0;
  }

  /** 至少有一个账号可发送 */
  canSend(): boolean {
    return this.accounts.some((account) => canSendWechat(account));
  }

  describe(): ProviderStatus {
    const bound = this.accounts.length;
    const sendable = this.accounts.filter((account) => canSendWechat(account)).length;
    let detail: string;
    if (bound === 0) {
      detail = '没有任何账号绑定微信；请在「设置 → 微信提醒」获取二维码，扫码后向机器人发送一句话';
    } else {
      const states = this.accountStates().map((state) => `账号 #${state.userId}：${state.label}`);
      detail = `${bound} 个账号已绑定微信，其中 ${sendable} 个可发送；${states.join('；')}`;
    }
    return {
      channel: this.channel,
      name: this.name,
      configured: bound > 0,
      reachable: this.lastReachable,
      probedAt: this.lastProbedAt,
      detail,
    };
  }

  /**
   * 只读连通性探测：不发送任何消息。
   *
   * 用**第一个已绑定账号**自己的通道地址探测（凭据不再有全局来源）；
   * 一个账号都没绑定时如实返回"未探测"，不假装通道可用。
   */
  async probe(): Promise<ProviderStatus> {
    await this.refresh();
    const first = this.accounts[0];
    const base = this.describe();
    if (!first?.account) return base;

    let credentials: WechatCredentials;
    try {
      credentials = unseal<WechatCredentials>(first.account);
    } catch {
      return { ...base, reachable: false, probedAt: new Date().toISOString(), detail: `${base.detail}；凭据无法解密，无法探测链路` };
    }

    const status = await new IlinkWechatProvider({ credentials: { ...credentials, contextToken: '' } }).probe();
    this.lastReachable = status.reachable;
    this.lastProbedAt = status.probedAt;
    const link = status.reachable === null ? '未探测' : status.reachable ? '可达' : '不可达';
    return {
      ...this.describe(),
      detail: `${base.detail}；链路${link}（以账号 #${first.userId} 的通道地址探测）`,
    };
  }

  async send(payload: NotificationJobPayload): Promise<SendResult> {
    const text = `${payload.title}\n${payload.body}`.trim();
    if (!text) return { ok: false, kind: 'rejected', error: 'empty_text' };
    const parts = chunkText(text).length;
    if (parts > PAUSE_AT - 1) return { ok: false, kind: 'rejected', error: 'message_exceeds_entire_wechat_window' };

    // ── 预约：只在该任务**所属账号自己**的行上判定与计数 ──
    const reservation = await updateWechatState(payload.userId, (s): Reservation => {
      if (!s.account) return { kind: 'unbound' };
      // 没有上下文就没有收件人，发出去也会被上游拒（改造前同一判断）
      if (!s.context) return { kind: 'deferred', reason: 'WECHAT_AWAITING_CONTEXT_REFRESH' };
      if (!canSendWechat(s)) {
        return { kind: 'deferred', reason: `WECHAT_SEND_PAUSED:${s.pausedReason ?? 'window'}` };
      }

      let credentials: WechatCredentials;
      let contextToken: string;
      try {
        credentials = unseal<WechatCredentials>(s.account);
        contextToken = unseal<string>(s.context);
      } catch {
        return { kind: 'deferred', reason: 'WECHAT_CREDENTIAL_ERROR: 凭据无法解密，请重新扫码绑定' };
      }

      const warning = !s.warned && s.used + parts >= WARN_AT;
      const needed = parts + (warning ? 1 : 0);
      if (s.used + needed > PAUSE_AT) {
        s.pausedReason = 'window_capacity';
        return { kind: 'deferred', reason: 'WECHAT_WINDOW_CAPACITY: 本账号发送窗口剩余不足，保留待发' };
      }
      // Reserve before network I/O. A crash leaves uncertain requests counted, never creates free quota.
      s.used += needed;
      s.unknown += needed;
      if (warning) {
        s.warned = true;
        s.warningResult = 'unknown';
      }
      if (s.used >= PAUSE_AT) s.pausedReason = 'threshold';
      return {
        kind: 'ok',
        revision: s.revision,
        credentials: { ...credentials, contextToken },
        warning,
        normalUsed: s.used - (warning ? 1 : 0),
      };
    });

    if (reservation.kind === 'unbound') {
      // 该账号没有绑定：绝不退回任何全局/他人凭据。任务交还 pending 等用户扫码。
      return {
        ok: false,
        kind: 'deferred',
        error: `WECHAT_ACCOUNT_NOT_BOUND: 账号 #${payload.userId} 尚未绑定微信，提醒保留待发`,
      };
    }
    if (reservation.kind === 'deferred') return { ok: false, kind: 'deferred', error: reservation.reason };

    const { revision, credentials, warning, normalUsed } = reservation;

    // 回填结果：只在**同一修订号**上生效，避免刷新/换绑期间的旧结果覆盖新状态
    const record = async (outcome: ChunkOutcome, isWarning = false) => {
      await updateWechatState(payload.userId, (s) => {
        if (s.revision !== revision) return;
        if (outcome.kind === 'accepted') {
          s.accepted++;
          s.unknown--;
        } else if (['auth_or_context', 'business_error', 'http_error'].includes(outcome.kind)) {
          s.failed++;
          s.unknown--;
        }
        if (outcome.kind === 'auth_or_context') s.pausedReason = 'context_rejected';
        if (isWarning) {
          s.warningResult =
            outcome.kind === 'accepted'
              ? 'accepted'
              : ['unknown', 'timeout'].includes(outcome.kind)
                ? 'unknown'
                : 'failed';
        }
      });
    };

    const provider = new IlinkWechatProvider({ credentials, onChunk: (o) => record(o) });
    const result = await provider.send(payload);

    if (warning) {
      // A refresh while the normal request was in flight invalidates the old warning reservation.
      const current = await readWechatState(payload.userId);
      if (current.revision === revision && current.pausedReason !== 'context_rejected') {
        const warningProvider = new IlinkWechatProvider({ credentials, onChunk: (o) => record(o, true) });
        await warningProvider.send({
          ...payload,
          idempotencyKey: `context-warning:${revision}`,
          title: '【Life OS】请刷新微信提醒窗口',
          body:
            `本轮已占用 ${normalUsed} 次发送请求，提醒窗口可能即将用尽。` +
            `请回复任意文字或发送 /refresh-context，继续接收提醒。`,
        });
      }
    }

    await this.refresh();
    return result;
  }
}

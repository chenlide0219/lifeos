import type { NotificationJobPayload, NotificationProvider, ProviderStatus, SendResult } from '../provider';
import { IlinkWechatProvider, chunkText, type ChunkOutcome } from './ilink';
import { canSendWechat, emptyWechatState, PAUSE_AT, WARN_AT, readWechatState, unseal, updateWechatState,
  type WechatCredentials, type WechatState } from '../../server/lib/wechat-state';

export class ManagedWechatProvider implements NotificationProvider {
  readonly channel = 'wechat';
  readonly name = '微信（iLink 发送通道）';
  private state: WechatState = emptyWechatState();
  // Preserve the existing server-only environment route for backward compatibility.
  // QR-bound accounts always take priority and use the persisted window below.
  private legacy = new IlinkWechatProvider();
  async refresh(): Promise<void> { this.state = await readWechatState(); }
  isConfigured(): boolean { return this.state.account ? true : this.legacy.isConfigured(); }
  canSend(): boolean { return this.state.account ? canSendWechat(this.state) : this.legacy.isConfigured(); }
  describe(): ProviderStatus {
    if (!this.state.account) return this.legacy.describe();
    let detail = !this.state.context ? '已扫码绑定；请在微信向机器人发送一句话以启用提醒' :
      !this.canSend() ? '微信发送已暂停，请回复消息或发送 /refresh-context 刷新上下文' :
      `已绑定；本轮占用 ${this.state.used}/${PAUSE_AT} 次（经验估计）`;
    try { unseal<WechatCredentials>(this.state.account); }
    catch { detail = '凭据无法解密，请重新扫码绑定'; }
    return { ...this.legacy.describe(), configured: true, name: this.name, detail };
  }
  async probe(): Promise<ProviderStatus> { await this.refresh(); await this.legacy.probe(); return this.describe(); }
  async send(payload: NotificationJobPayload): Promise<SendResult> {
    await this.refresh();
    if (!this.state.account) return this.legacy.send(payload);
    const text = `${payload.title}\n${payload.body}`.trim();
    if (!text) return { ok: false, kind: 'rejected', error: 'empty_text' };
    const parts = chunkText(text).length;
    if (parts > PAUSE_AT - 1) return { ok: false, kind: 'rejected', error: 'message_exceeds_entire_wechat_window' };
    const reservation = await updateWechatState(s => {
      if (!canSendWechat(s)) return null;
      const warning = !s.warned && s.used + parts >= WARN_AT;
      const needed = parts + (warning ? 1 : 0);
      if (s.used + needed > PAUSE_AT) { s.pausedReason = 'window_capacity'; return null; }
      const credentials = unseal<WechatCredentials>(s.account!);
      const contextToken = unseal<string>(s.context!);
      // Reserve before network I/O. A crash leaves uncertain requests counted, never creates free quota.
      s.used += needed; s.unknown += needed;
      if (warning) { s.warned = true; s.warningResult = 'unknown'; }
      if (s.used >= PAUSE_AT) s.pausedReason = 'threshold';
      return { revision: s.revision, credentials: { ...credentials, contextToken }, warning, normalUsed: s.used - (warning ? 1 : 0) };
    });
    if (!reservation) return { ok: false, kind: 'deferred', error: 'WECHAT_AWAITING_CONTEXT_REFRESH' };
    const record = async (outcome: ChunkOutcome, warning = false) => {
      await updateWechatState(s => {
        if (s.revision !== reservation.revision) return;
        if (outcome.kind === 'accepted') { s.accepted++; s.unknown--; }
        else if (['auth_or_context', 'business_error', 'http_error'].includes(outcome.kind)) { s.failed++; s.unknown--; }
        if (outcome.kind === 'auth_or_context') s.pausedReason = 'context_rejected';
        if (warning) s.warningResult = outcome.kind === 'accepted' ? 'accepted' :
          ['unknown', 'timeout'].includes(outcome.kind) ? 'unknown' : 'failed';
      });
    };
    const provider = new IlinkWechatProvider({ credentials: reservation.credentials, onChunk: o => record(o) });
    const result = await provider.send(payload);
    if (reservation.warning) {
      // A refresh while the normal request was in flight invalidates the old warning reservation.
      const current = await readWechatState();
      if (current.revision === reservation.revision && current.pausedReason !== 'context_rejected') {
        const warningProvider = new IlinkWechatProvider({ credentials: reservation.credentials, onChunk: o => record(o, true) });
        await warningProvider.send({ ...payload, idempotencyKey: `context-warning:${reservation.revision}`,
          title: '【Life OS】请刷新微信提醒窗口',
          body: `本轮已占用 ${reservation.normalUsed} 次发送请求，提醒窗口可能即将用尽。请回复任意文字或发送 /refresh-context，继续接收提醒。` });
      }
    }
    await this.refresh();
    return result;
  }
}

import crypto from 'node:crypto';
import { ilinkRequest } from '../server/lib/wechat-api';
import { seal, unseal, updateWechatState, readWechatState, type WechatCredentials } from '../server/lib/wechat-state';

/** Commit cursor and inbound deduplication together; only the bound sender can refresh. */
export async function pollWechatUpdates(signal?: AbortSignal): Promise<void> {
  const initial = await readWechatState();
  if (!initial.account) return;
  const account = unseal<WechatCredentials>(initial.account);
  const data = await ilinkRequest(account.baseUrl, 'ilink/bot/getupdates', {
    token: account.token, body: { get_updates_buf: initial.cursor, base_info: { channel_version: '0.1.0' } }, signal, timeout: 30_000,
  });
  await updateWechatState(s => {
    if (s.generation !== initial.generation || !s.account) return;
    s.listenerAt = Date.now(); s.listenerError = null;
    if ((typeof data.ret === 'number' && data.ret !== 0) || (typeof data.errcode === 'number' && data.errcode !== 0)) {
      s.listenerError = '微信接收接口拒绝请求，请检查绑定状态';
      if (data.ret === -14 || data.errcode === -14) s.pausedReason = 'login_expired';
      return;
    }
    if (typeof data.get_updates_buf === 'string' && data.get_updates_buf) s.cursor = data.get_updates_buf;
    if (!Array.isArray(data.msgs)) return;
    const messages = data.msgs.filter((m: unknown): m is Record<string, unknown> => Boolean(m && typeof m === 'object'));
    messages.sort((a,b) => Number(a.create_time_ms ?? 0) - Number(b.create_time_ms ?? 0));
    for (const msg of messages) {
      if (msg.message_type !== 1 || msg.from_user_id !== account.userId || typeof msg.context_token !== 'string' || !msg.context_token) continue;
      const id = String(msg.message_id ?? msg.seq ?? crypto.createHash('sha256').update(JSON.stringify(msg)).digest('hex'));
      if (s.seen.includes(id)) continue;
      s.seen = [...s.seen, id].slice(-200);
      const time = Number(msg.create_time_ms ?? 0);
      if (time && (time < s.boundAt || time < s.lastInboundTime)) continue;
      s.context = seal(msg.context_token); s.revision = crypto.randomUUID(); s.refreshedAt = Date.now();
      s.lastInboundTime = Math.max(s.lastInboundTime, time);
      s.used = s.accepted = s.failed = s.unknown = 0;
      s.warned = false; s.warningResult = null;
      // A message can renew context, not an expired bot login.
      if (s.pausedReason !== 'login_expired') s.pausedReason = null;
    }
  });
}
export function startWechatListener(): () => Promise<void> {
  const controller = new AbortController();
  const pause = () => new Promise<void>(resolve => {
    if (controller.signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, 3000); controller.signal.addEventListener('abort', done, { once: true });
  });
  const running = (async () => {
    while (!controller.signal.aborted) {
      try { await pollWechatUpdates(controller.signal); }
      catch {
        if (!controller.signal.aborted) await updateWechatState(s => { s.listenerError = '微信接收连接异常，正在重试'; }).catch(() => undefined);
      }
      await pause();
    }
  })();
  return async () => { controller.abort(); await running; };
}

import { Hono } from 'hono';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { requireAuth, type AppEnv } from '../middleware/auth';
import { rateLimit } from '../lib/ratelimit';
import { bindWechat, emptyWechatState, publicWechatState, readWechatState, updateWechatState } from '../lib/wechat-state';
import { ILINK_LOGIN_BASE, ilinkRequest, trustedIlinkBase } from '../lib/wechat-api';

export const wechatRoutes = new Hono<AppEnv>();
type Login = { id: string; generation: string; qrcode: string; image: string; base: string;
  expires: number; status: string; polling: boolean; controller: AbortController };
let login: Login | null = null;
function view(l: Login) { return { id: l.id, image: l.image, status: l.status, expiresAt: new Date(l.expires).toISOString() }; }
wechatRoutes.use('*', requireAuth);
wechatRoutes.get('/', async c => c.json(publicWechatState(await readWechatState())));
wechatRoutes.post('/login', async c => {
  const limited = rateLimit('wechat-login', 10, 10 * 60_000);
  if (!limited.ok) return c.json({ error: 'rate_limited', message: '获取二维码过于频繁，请稍后再试' }, 429);
  try {
    // Invalidate any old in-flight QR flow before creating a replacement.
    login?.controller.abort(); login = null;
    const generation = await updateWechatState(s => { s.generation = crypto.randomUUID(); return s.generation; });
    const qr = await ilinkRequest(ILINK_LOGIN_BASE, 'ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: [] }, timeout: 15_000 });
    if (typeof qr.qrcode !== 'string' || !qr.qrcode || typeof qr.qrcode_img_content !== 'string' || !qr.qrcode_img_content || qr.qrcode_img_content.length > 8192) throw new Error('invalid QR');
    const l: Login = { id: crypto.randomUUID(), generation, qrcode: qr.qrcode,
      image: await QRCode.toDataURL(qr.qrcode_img_content, { width: 280, margin: 2 }),
      base: ILINK_LOGIN_BASE, expires: Date.now() + 8 * 60_000, status: 'wait', polling: false, controller: new AbortController() };
    if ((await readWechatState()).generation !== generation) return c.json({ error: 'superseded', message: '已有更新的扫码请求，请重新获取' }, 409);
    login = l; return c.json(view(l));
  } catch { return c.json({ error: 'wechat_login_error', message: '获取微信二维码失败，请重试' }, 502); }
});
wechatRoutes.post('/login/:id/poll', async c => {
  const l = login;
  if (!l || l.id !== c.req.param('id')) return c.json({ error: 'expired', message: '扫码会话已失效，请重新获取二维码' }, 410);
  if (Date.now() >= l.expires) { l.status = 'expired'; l.controller.abort(); return c.json(view(l)); }
  if (['confirmed', 'expired', 'verify_code_blocked', 'binded_redirect'].includes(l.status) || l.polling) return c.json(view(l));
  const body = await c.req.json<{ verifyCode?: string }>().catch(() => ({} as { verifyCode?: string }));
  if (body.verifyCode !== undefined && !/^\d{4,8}$/.test(body.verifyCode)) return c.json({ error: 'invalid_request', message: '请输入手机显示的 4–8 位数字验证码' }, 400);
  l.polling = true;
  try {
    const data = await ilinkRequest(l.base, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(l.qrcode)}${body.verifyCode ? `&verify_code=${encodeURIComponent(body.verifyCode)}` : ''}`, { signal: l.controller.signal, timeout: 30_000 });
    if (login !== l || Date.now() >= l.expires || l.controller.signal.aborted) return c.json({ error: 'expired', message: '扫码会话已失效' }, 410);
    if (data.status === 'confirmed') {
      if (typeof data.bot_token !== 'string' || !data.bot_token || typeof data.ilink_bot_id !== 'string' || !data.ilink_bot_id || typeof data.ilink_user_id !== 'string' || !data.ilink_user_id) throw new Error('missing credentials');
      const ok = await bindWechat({ token: data.bot_token, botId: data.ilink_bot_id, userId: data.ilink_user_id,
        baseUrl: data.baseurl ? trustedIlinkBase(String(data.baseurl)) : l.base }, l.generation);
      if (!ok) return c.json({ error: 'expired', message: '扫码会话已被更新，请重新获取' }, 410);
      l.status = 'confirmed'; l.image = ''; l.qrcode = '';
    } else if (data.status === 'scaned_but_redirect' && typeof data.redirect_host === 'string') {
      l.base = trustedIlinkBase(`https://${data.redirect_host}/`); l.status = 'scaned';
    } else if (typeof data.status === 'string' && ['wait', 'scaned', 'expired', 'need_verifycode', 'verify_code_blocked', 'binded_redirect'].includes(data.status)) l.status = data.status;
    else throw new Error('unexpected login status');
    return c.json(view(l));
  } catch { return c.json({ error: 'wechat_poll_error', message: '查询扫码状态失败，请稍后重试' }, 502); }
  finally { l.polling = false; }
});
wechatRoutes.delete('/login', async c => {
  login?.controller.abort(); login = null;
  await updateWechatState(s => { s.generation = crypto.randomUUID(); });
  return c.body(null, 204);
});
wechatRoutes.delete('/', async c => {
  login?.controller.abort(); login = null;
  await updateWechatState(s => Object.assign(s, emptyWechatState()));
  return c.body(null, 204);
});

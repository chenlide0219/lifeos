import { Hono } from 'hono';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { wechatOperations, wechatOutbox } from '../db/schema';
import { requireAuth, type AppEnv } from '../middleware/auth';
import { rateLimit } from '../lib/ratelimit';
import { ownedBy } from '../lib/scope';
import { inboxCounts } from '../lib/wechat-inbox';
import { outboxCounts } from '../lib/wechat-outbox';
import { bindWechat, emptyWechatState, publicWechatState, readWechatState, updateWechatState } from '../lib/wechat-state';
import { ILINK_LOGIN_BASE, ilinkRequest, trustedIlinkBase } from '../lib/wechat-api';

export const wechatRoutes = new Hono<AppEnv>();
type Login = { id: string; generation: string; qrcode: string; image: string; base: string;
  expires: number; status: string; polling: boolean; controller: AbortController };

/**
 * 扫码会话**按账号分槽**（key = userId）。
 *
 * ⚠️ 这里曾经是一个全局单例 `let login: Login | null`，在多用户下有两个真实缺陷：
 *   1. 账号 B 获取二维码会 abort 掉账号 A 正在进行的扫码（互相干扰）；
 *   2. 更严重：B 只要拿到 A 的 login id 去 poll，`bindWechat` 会以**调用者的 userId**
 *      去绑 A 扫出来的凭据，等于把 A 的微信绑定挂到 B 名下（跨账号凭据错绑）。
 * 分槽之后，poll/删除都只查自己那一槽，B 在数据结构上就够不到 A 的会话。
 */
const logins = new Map<number, Login>();
function dropLogin(userId: number): void {
  logins.get(userId)?.controller.abort();
  logins.delete(userId);
}
function view(l: Login) { return { id: l.id, image: l.image, status: l.status, expiresAt: new Date(l.expires).toISOString() }; }
wechatRoutes.use('*', requireAuth);
wechatRoutes.get('/', async c => c.json(publicWechatState(await readWechatState(c.get('user').id))));

/**
 * V1.1 助手状态（设置页展示）。
 *
 * 只暴露**可公开的运营信息**：当前草稿的标题/短码/状态、最近操作的终态、
 * 入站与出站的计数分布。不含正文以外的任何私有数据，也不含凭据。
 *
 * 用途：真机排查时能直接看到"消息有没有进来""草稿建了没有""回复发出去了没有"，
 * 而不必登录服务器查库。
 */
wechatRoutes.get('/assistant', requireAuth, async (c) => {
  const userId = c.get('user').id;
  // 绑定代际已是"每账号一份"（lib/wechat-state.ts 按 userId 读状态），
  // 因此这里的 generation 就是当前账号的；查询里仍同时带 ownedBy，
  // 使"代际对了但行不属于我"这种情况也不可能读出数据。
  const state = await readWechatState(userId);
  const generation = state.generation;

  const [draft] = await db
    .select({
      id: wechatOperations.id,
      status: wechatOperations.status,
      shortCode: wechatOperations.shortCode,
      version: wechatOperations.version,
      draft: wechatOperations.draft,
      missingFields: wechatOperations.missingFields,
      expiresAt: wechatOperations.expiresAt,
      updatedAt: wechatOperations.updatedAt,
    })
    .from(wechatOperations)
    .where(
      and(
        eq(wechatOperations.bindingGeneration, generation),
        inArray(wechatOperations.status, ['awaiting_fields', 'pending_confirm', 'committing']),
        ownedBy(wechatOperations, userId),
      ),
    )
    .limit(1);

  const recent = await db
    .select({
      id: wechatOperations.id,
      status: wechatOperations.status,
      draftKind: wechatOperations.draftKind,
      draft: wechatOperations.draft,
      resultSubjectType: wechatOperations.resultSubjectType,
      resultSubjectId: wechatOperations.resultSubjectId,
      updatedAt: wechatOperations.updatedAt,
    })
    .from(wechatOperations)
    .where(and(eq(wechatOperations.bindingGeneration, generation), ownedBy(wechatOperations, userId)))
    .orderBy(desc(wechatOperations.updatedAt))
    .limit(8);

  const recentReplies = await db
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
    .orderBy(desc(wechatOutbox.createdAt))
    .limit(10);

  return c.json({
    // 输入开关：关闭时业务输入不处理，但主动提醒照常
    inboundEnabled: (process.env.WECHAT_INBOUND_ENABLED ?? '1') !== '0',
    modelCallsEnabled: (process.env.WECHAT_MODEL_CALLS ?? '1') !== '0',
    draft: draft
      ? {
          id: draft.id,
          status: draft.status,
          shortCode: draft.shortCode,
          version: draft.version,
          title: draftTitle(draft.draft),
          kind: draftKindOf(draft.draft),
          missingFields: Array.isArray(draft.missingFields) ? draft.missingFields : [],
          expiresAt: draft.expiresAt,
          updatedAt: draft.updatedAt,
        }
      : null,
    recent: recent.map((row) => ({
      id: row.id,
      status: row.status,
      title: draftTitle(row.draft),
      kind: row.draftKind ?? draftKindOf(row.draft),
      resultSubjectType: row.resultSubjectType,
      resultSubjectId: row.resultSubjectId,
      updatedAt: row.updatedAt,
    })),
    recentReplies,
    inboundCounts: await inboxCounts(userId),
    outboxCounts: await outboxCounts(userId),
    listenerAt: state.listenerAt ? new Date(state.listenerAt).toISOString() : null,
    listenerError: state.listenerError,
  });
});

function draftTitle(draft: unknown): string | null {
  if (!draft || typeof draft !== 'object') return null;
  const title = (draft as Record<string, unknown>).title;
  return typeof title === 'string' && title.trim() ? title : null;
}

function draftKindOf(draft: unknown): string | null {
  if (!draft || typeof draft !== 'object') return null;
  const kind = (draft as Record<string, unknown>).kind;
  return kind === 'event' || kind === 'task' ? kind : null;
}
wechatRoutes.post('/login', async c => {
  const userId = c.get('user').id;
  const limited = rateLimit('wechat-login', 10, 10 * 60_000);
  if (!limited.ok) return c.json({ error: 'rate_limited', message: '获取二维码过于频繁，请稍后再试' }, 429);
  try {
    // Invalidate any old in-flight QR flow before creating a replacement.
    // 只作废**本账号**上一次的扫码，不影响其他账号正在进行的扫码。
    dropLogin(userId);
    const generation = await updateWechatState(userId, s => { s.generation = crypto.randomUUID(); return s.generation; });
    const qr = await ilinkRequest(ILINK_LOGIN_BASE, 'ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: [] }, timeout: 15_000 });
    if (typeof qr.qrcode !== 'string' || !qr.qrcode || typeof qr.qrcode_img_content !== 'string' || !qr.qrcode_img_content || qr.qrcode_img_content.length > 8192) throw new Error('invalid QR');
    const l: Login = { id: crypto.randomUUID(), generation, qrcode: qr.qrcode,
      image: await QRCode.toDataURL(qr.qrcode_img_content, { width: 280, margin: 2 }),
      base: ILINK_LOGIN_BASE, expires: Date.now() + 8 * 60_000, status: 'wait', polling: false, controller: new AbortController() };
    if ((await readWechatState(userId)).generation !== generation) return c.json({ error: 'superseded', message: '已有更新的扫码请求，请重新获取' }, 409);
    logins.set(userId, l); return c.json(view(l));
  } catch { return c.json({ error: 'wechat_login_error', message: '获取微信二维码失败，请重试' }, 502); }
});
wechatRoutes.post('/login/:id/poll', async c => {
  const userId = c.get('user').id;
  // 只取本账号自己那一槽：别人的 login id 在这里根本查不到，因此不可能被绑到本账号名下
  const l = logins.get(userId);
  if (!l || l.id !== c.req.param('id')) return c.json({ error: 'expired', message: '扫码会话已失效，请重新获取二维码' }, 410);
  if (Date.now() >= l.expires) { l.status = 'expired'; l.controller.abort(); return c.json(view(l)); }
  if (['confirmed', 'expired', 'verify_code_blocked', 'binded_redirect'].includes(l.status) || l.polling) return c.json(view(l));
  const body = await c.req.json<{ verifyCode?: string }>().catch(() => ({} as { verifyCode?: string }));
  if (body.verifyCode !== undefined && !/^\d{4,8}$/.test(body.verifyCode)) return c.json({ error: 'invalid_request', message: '请输入手机显示的 4–8 位数字验证码' }, 400);
  l.polling = true;
  try {
    const data = await ilinkRequest(l.base, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(l.qrcode)}${body.verifyCode ? `&verify_code=${encodeURIComponent(body.verifyCode)}` : ''}`, { signal: l.controller.signal, timeout: 30_000 });
    if (logins.get(userId) !== l || Date.now() >= l.expires || l.controller.signal.aborted) return c.json({ error: 'expired', message: '扫码会话已失效' }, 410);
    if (data.status === 'confirmed') {
      if (typeof data.bot_token !== 'string' || !data.bot_token || typeof data.ilink_bot_id !== 'string' || !data.ilink_bot_id || typeof data.ilink_user_id !== 'string' || !data.ilink_user_id) throw new Error('missing credentials');
      const ok = await bindWechat(userId, { token: data.bot_token, botId: data.ilink_bot_id, userId: data.ilink_user_id,
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
  const userId = c.get('user').id;
  dropLogin(userId);
  await updateWechatState(userId, s => { s.generation = crypto.randomUUID(); });
  return c.body(null, 204);
});
wechatRoutes.delete('/', async c => {
  const userId = c.get('user').id;
  dropLogin(userId);
  await updateWechatState(userId, s => Object.assign(s, emptyWechatState(userId)));
  return c.body(null, 204);
});

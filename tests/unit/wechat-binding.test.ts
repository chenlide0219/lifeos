import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { requireTestDatabase } from '../helpers/guard';

// Guard the target and force every imported DB client onto it, even when this file runs alone.
process.env.DATABASE_URL = requireTestDatabase();
process.env.SESSION_SECRET = 'test-secret-at-least-thirty-two-characters-long';
delete process.env.ILINK_TOKEN;
delete process.env.ILINK_TO_USER_ID;
const { pool } = await import('../../src/server/db/client');
const { db } = await import('../../src/server/db/client');
const { notificationJobs } = await import('../../src/server/db/schema');
const { tick } = await import('../../src/worker/core');
const { createApp } = await import('../../src/server/app');
const { hashPassword } = await import('../../src/server/lib/password');
const { ManagedWechatProvider } = await import('../../src/worker/providers/managed-wechat');
const { pollWechatUpdates } = await import('../../src/worker/wechat-listener');
const { readWechatState, updateWechatState, WECHAT_STATE_KEY } = await import('../../src/server/lib/wechat-state');
const app = createApp();
const originalFetch = globalThis.fetch;
let cookie = '';
let inbound = false;
let inboundId = 1;
let sends = 0;
let warningSends = 0;
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

before(async () => {
  await pool.query('DELETE FROM settings WHERE key=$1', [WECHAT_STATE_KEY]);
  await pool.query('TRUNCATE admin_users, sessions, audit_logs RESTART IDENTITY CASCADE');
  await pool.query('INSERT INTO admin_users(username,password_hash) VALUES($1,$2)', ['wechat-test', await hashPassword('WeChat-Test-Pass-1!')]);
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'wechat-test', password: 'WeChat-Test-Pass-1!' }) });
  assert.equal(login.status, 200);
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('get_bot_qrcode')) return response({ qrcode: 'fake-qr', qrcode_img_content: 'https://wechat.example/scan' });
    if (url.includes('get_qrcode_status')) return response({ status: 'confirmed', bot_token: 'fake-private-bot-token',
      ilink_bot_id: 'lifeos-bot', ilink_user_id: 'owner@im.wechat', baseurl: 'https://ilinkai.weixin.qq.com' });
    if (url.includes('getupdates')) return response({ ret: 0, get_updates_buf: `cursor-${inboundId}`,
      msgs: inbound ? [{ message_type: 1, from_user_id: 'owner@im.wechat', message_id: inboundId,
        create_time_ms: Date.now() + 1000, context_token: `context-${inboundId}`,
        // 真实文本消息必然带正文；缺少它会让"绑定用户消息"无法被识别为可处理文本
        item_list: [{ type: 1, text_item: { text: '明天下午三点开组会' } }] }] : [] });
    if (url.includes('sendmessage')) {
      sends++;
      const body = JSON.parse(String(init?.body)) as { msg: { item_list: { text_item: { text: string } }[] } };
      if (body.msg.item_list[0]?.text_item.text.includes('请刷新微信提醒窗口')) warningSends++;
      return response({ ret: 0, message_id: sends });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = originalFetch;
  await pool.query('DELETE FROM notification_jobs WHERE idempotency_key=$1', ['wechat-window-test-job']);
  await pool.query('DELETE FROM settings WHERE key=$1', [WECHAT_STATE_KEY]);
  await pool.query('TRUNCATE admin_users, sessions, audit_logs RESTART IDENTITY CASCADE');
  await pool.end();
});
function call(path: string, method = 'GET', body?: unknown) {
  return app.request(path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}
describe('LifeOS 独立扫码和发送窗口', () => {
  it('登录仅回二维码，凭据加密保存且不进入业务导出', async () => {
    const start = await call('/api/wechat/login', 'POST');
    assert.equal(start.status, 200);
    const qr = await start.json() as { id: string; image: string };
    assert.match(qr.image, /^data:image\/png;base64,/);
    const poll = await call(`/api/wechat/login/${qr.id}/poll`, 'POST', {});
    assert.equal(poll.status, 200);
    assert.equal((await poll.json() as { status: string }).status, 'confirmed');
    const state = await readWechatState();
    assert.ok(state.account && !state.account.includes('fake-private-bot-token'));
    const exported = await call('/api/export/data.json');
    assert.equal(exported.status, 200);
    assert.ok(!(await exported.text()).includes(WECHAT_STATE_KEY));
  });
  it('收到绑定用户消息后恢复，第八次另发提醒，第十次后暂停', async () => {
    inbound = true;
    await pollWechatUpdates();
    const provider = new ManagedWechatProvider();
    for (let i = 0; i < 9; i++) {
      const result = await provider.send({ jobId: `test-${i}`, title: '提醒', body: '测试',
        subjectType: 'event', subjectId: 'event-id', idempotencyKey: `test-${i}` });
      assert.equal(result.ok, true);
    }
    const state = await readWechatState();
    assert.equal(state.used, 10);
    assert.equal(state.accepted, 10);
    assert.equal(warningSends, 1);
    assert.equal(sends, 10);
    assert.equal(provider.canSend(), false);
    const blocked = await provider.send({ jobId: 'blocked', title: '提醒', body: '停发', subjectType: 'event', subjectId: 'event-id', idempotencyKey: 'blocked' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.ok === false && blocked.kind, 'deferred');
    assert.equal(sends, 10);
    inboundId++;
    await pollWechatUpdates();
    await provider.refresh();
    assert.equal(provider.canSend(), true);
    assert.equal((await readWechatState()).used, 0);
  });
  it('Worker 暂停时不领取任务，收到新消息后才恢复派发', async () => {
    await updateWechatState(s => { s.used = 10; s.pausedReason = 'threshold'; });
    const [job] = await db.insert(notificationJobs).values({ subjectType: 'system', subjectId: crypto.randomUUID(),
      title: '暂停演练', body: '测试', fireAt: new Date(), idempotencyKey: 'wechat-window-test-job' }).returning({ id: notificationJobs.id });
    assert.ok(job);
    const paused = await tick();
    assert.equal(paused.claimed, 0);
    const pending = await pool.query<{ status: string }>('SELECT status FROM notification_jobs WHERE id=$1', [job.id]);
    assert.equal(pending.rows[0]?.status, 'pending');
    inboundId++;
    await pollWechatUpdates();
    const resumed = await tick();
    assert.equal(resumed.sent, 1);
    const sent = await pool.query<{ status: string }>('SELECT status FROM notification_jobs WHERE id=$1', [job.id]);
    assert.equal(sent.rows[0]?.status, 'sent');
  });
});

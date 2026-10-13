/**
 * 阶段 5 回归：发送测试消息（PRD FR-07）。
 *
 * 最要紧的一条：**未配置渠道时必须如实拒绝**，不排队、不假装已发送。
 * 已配置时也只排队并返回 jobId，是否送达以任务记录为准，
 * 绝不凭接口返回推断送达。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { requireTestDatabase } from '../helpers/guard';

requireTestDatabase();
// 绑定凭据按账号加密存储（AES-256-GCM），夹具要写出真实可解密的密文，因此必须有密钥
process.env.SESSION_SECRET ??= 'test-secret-at-least-thirty-two-characters-long';

const { db, pool } = await import('../../src/server/db/client');
const { createApp } = await import('../../src/server/app');
const { users } = await import('../../src/server/db/schema');
const { hashPassword } = await import('../../src/server/lib/password');
const { emptyWechatState, seal, updateWechatState } = await import('../../src/server/lib/wechat-state');

const app = createApp();
const PASSWORD = 'Notify-Test-Pass-1!';
let cookie = '';
let userId = 0;

/**
 * "渠道已配置" = 该账号自己有一行**可发送**的绑定。
 *
 * ⚠️ 旧夹具是设 `ILINK_TOKEN` / `ILINK_TO_USER_ID`——那条全局兜底已被有意移除
 * （一个全局凭据无法归属到任何账号），因此这里改为写 `wechat_accounts`。
 * 必须有 `context`：只写凭据不写上下文会被判成"等待上下文"，
 * `/api/notifications/test` 会返回 409 而不是 202。
 */
async function withProvider(): Promise<void> {
  await updateWechatState(userId, (s) => {
    Object.assign(s, emptyWechatState(userId), {
      generation: crypto.randomUUID(),
      account: seal({
        token: 'test-token',
        userId: 'test-recipient',
        botId: 'lifeos-bot',
        baseUrl: 'https://ilink.test.invalid',
      }),
      context: seal('test-context'),
      cursor: '',
      revision: crypto.randomUUID(),
      seen: [],
      used: 0,
      accepted: 0,
      failed: 0,
      unknown: 0,
      warned: false,
      warningResult: null,
      pausedReason: null,
      boundAt: Date.now(),
      refreshedAt: Date.now(),
      lastInboundTime: 0,
      listenerAt: null,
      listenerError: null,
    });
  });
}

/**
 * "渠道未配置" = 没有任何可发送账号。
 *
 * 这里清的是**全部** `wechat_accounts` 行（而不只是本账号的）：渠道是否已配置
 * 是全局读取（`isConfigured()` = 至少一个已绑定账号），同库其他测试残留的绑定
 * 会让"未配置"用例变成 202。
 */
async function withoutProvider(): Promise<void> {
  await db.execute(sql`DELETE FROM wechat_accounts`);
}

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
}

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

async function systemJobCount(): Promise<number> {
  const r = (await db.execute(
    sql`SELECT count(*)::int AS n FROM notification_jobs WHERE subject_type = 'system'`,
  )) as unknown as { rows: { n: number }[] };
  return r.rows[0]!.n;
}

before(async () => {
  // TRUNCATE ... CASCADE 会连带清空 wechat_accounts（它外键指向 users）
  await db.execute(sql`TRUNCATE users, sessions, audit_logs RESTART IDENTITY CASCADE`);
  const [owner] = await db
    .insert(users)
    .values({ username: 'notify-test', passwordHash: await hashPassword(PASSWORD) })
    .returning({ id: users.id });
  userId = owner!.id;
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'notify-test', password: PASSWORD }),
  });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  assert.ok(cookie.startsWith('lifeos_session='));
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE notification_attempts, notification_jobs RESTART IDENTITY CASCADE`);
  // 每个用例都从"没有任何绑定"开始，由用例自己显式建立所需的绑定状态
  await withoutProvider();
});

after(async () => {
  await withoutProvider();
  await db.execute(sql`TRUNCATE users, sessions, audit_logs RESTART IDENTITY CASCADE`);
  await pool.end();
});

describe('未配置渠道时不得伪造发送', () => {
  it('返回 503，且**不创建任何任务**（不排队、不假装已发送）', async () => {
    await withoutProvider();
    const res = await request('/api/notifications/test', { method: 'POST' });

    assert.equal(res.status, 503, '未配置渠道必须明确失败，而不是返回成功');
    const body = await json<{ error: string; message: string; provider: { configured: boolean } }>(res);
    assert.equal(body.error, 'provider_not_configured');
    assert.match(body.message, /未配置|未排队/);
    assert.equal(body.provider.configured, false);

    assert.equal(await systemJobCount(), 0, '未配置时绝不能留下"待发送"的任务让人误以为会发出');
  });

  it('拒绝信息里说明为何不会发送', async () => {
    await withoutProvider();
    const body = await json<{ message: string }>(await request('/api/notifications/test', { method: 'POST' }));
    assert.ok(body.message.length > 10, '必须给出可读原因，而不是只有错误码');
  });
});

describe('已配置渠道时只排队，结果以任务记录为准', () => {
  it('返回 202 与 jobId，并说明结果需以任务记录为准', async () => {
    await withProvider();
    const res = await request('/api/notifications/test', { method: 'POST' });
    assert.equal(res.status, 202);

    const body = await json<{ job: { id: string; status: string }; note: string }>(res);
    assert.equal(body.job.status, 'pending', '刚排队时状态必须是 pending，不能直接是 sent');
    assert.match(body.note, /以任务记录为准/);
    assert.equal(await systemJobCount(), 1);
  });

  it('测试消息只尝试一次（用户就在跟前，无需后台反复重试）', async () => {
    await withProvider();
    const body = await json<{ job: { id: string } }>(
      await request('/api/notifications/test', { method: 'POST' }),
    );

    const r = (await db.execute(
      sql`SELECT max_attempts FROM notification_jobs WHERE id = ${body.job.id}`,
    )) as unknown as { rows: { max_attempts: number }[] };
    assert.equal(r.rows[0]!.max_attempts, 1);
  });

  it('可以查询测试任务的真实状态与尝试记录', async () => {
    await withProvider();
    const created = await json<{ job: { id: string } }>(
      await request('/api/notifications/test', { method: 'POST' }),
    );

    const res = await request(`/api/notifications/test/${created.job.id}`);
    assert.equal(res.status, 200);
    const body = await json<{ job: { status: string; attempts: number }; attempts: unknown[] }>(res);
    assert.equal(body.job.status, 'pending');
    assert.deepEqual(body.attempts, [], '尚未发送时不应有尝试记录');
  });

  it('查询不存在的测试任务返回 404', async () => {
    await withProvider();
    const res = await request('/api/notifications/test/00000000-0000-0000-0000-000000000000');
    assert.equal(res.status, 404);
  });

  it('非法任务 ID 返回 400', async () => {
    await withProvider();
    const res = await request('/api/notifications/test/not-a-uuid');
    assert.equal(res.status, 400);
  });

  it('连续发送触发限流，避免刷屏骚扰', async () => {
    await withProvider();
    let last = 0;
    for (let i = 0; i < 6; i++) {
      last = (await request('/api/notifications/test', { method: 'POST' })).status;
    }
    assert.equal(last, 429, '第 6 次应被限流');
  });
});

describe('认证', () => {
  it('未登录不得发送测试消息，也不得查询结果', async () => {
    const saved = cookie;
    cookie = '';
    try {
      assert.equal((await request('/api/notifications/test', { method: 'POST' })).status, 401);
      assert.equal(
        (await request('/api/notifications/test/00000000-0000-0000-0000-000000000000')).status,
        401,
      );
    } finally {
      cookie = saved;
    }
  });
});

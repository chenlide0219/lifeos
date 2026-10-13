/**
 * 账号管理与**强制改密闸门**回归（阶段 3）。
 *
 * 这个文件守两件容易被悄悄改坏的事：
 *
 * 1. **账号管理只对管理员开放**，且护栏在服务端（不能禁用自己、不能禁用唯一启用中的管理员、
 *    不做删除与角色变更）。绕过界面直接调接口也必须被拒绝。
 * 2. **强制改密是一道后端闸门，不是前端跳转**。由管理员设置或重置的密码是一次性凭据，
 *    在用户改密之前，除「查自己是谁 / 改密 / 登出」外的接口必须一律 403。
 *    只靠前端跳转的话，一个直接调接口的客户端就绕过了整条策略
 *    —— 而"初始密码可以是弱口令"这个让步（便于当面告知）正是以这道闸门为前提的。
 */
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { requireTestDatabase } from '../helpers/guard';

requireTestDatabase();

const { db, pool } = await import('../../src/server/db/client');
const { createApp } = await import('../../src/server/app');
const { users } = await import('../../src/server/db/schema');
const { hashPassword, checkPasswordStrength } = await import('../../src/server/lib/password');
const { resetRateLimit } = await import('../../src/server/lib/ratelimit');

const app = createApp();
const PASSWORD = 'Account-Mgmt-Pass-1!';

/**
 * 登录固定使用同一个测试 IP，并在每个用例前重置该 IP 的限速桶。
 *
 * 为什么必须这么做：登录限速是**按 IP 20 次 / 15 分钟**（进程内计数）。
 * 本文件每个用例都要重新登录两个账号，12 个用例就会超过 20 次，
 * 于是后面的用例会在 beforeEach 里被 429 拒绝——表现为"莫名其妙登录失败"。
 * 按用户的桶不必重置：登录成功后路由自己会清掉它。
 */
const TEST_IP = '203.0.113.7';

let adminCookie = '';
let memberCookie = '';
let adminId = 0;
let memberId = 0;

function as(cookie: string) {
  return (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(init.headers ?? {}),
      },
    });
}

const admin = (path: string, init?: RequestInit) => as(adminCookie)(path, init);
const member = (path: string, init?: RequestInit) => as(memberCookie)(path, init);

async function login(username: string, password: string): Promise<Response> {
  return app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': TEST_IP },
    body: JSON.stringify({ username, password }),
  });
}

function cookieOf(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

/** 读一次响应体再解析：避免在断言消息里 await res.text() 把 body 读掉 */
async function body<T>(res: Response): Promise<T> {
  const text = await res.text();
  assert.ok(text.length > 0, `响应应为 JSON，实际为空（HTTP ${res.status}）`);
  return JSON.parse(text) as T;
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE users, sessions, audit_logs RESTART IDENTITY CASCADE`);
  // 清掉上一轮累积的登录尝试（见 TEST_IP 处的说明）
  resetRateLimit(`login:ip:${TEST_IP}`);

  const inserted = (await db
    .insert(users)
    .values([
      // 两人的 must_change_password 都是 false：这样 403 的来源只可能是"权限不足"，
      // 不会被强制改密闸门抢先拦下（否则测的就不是 requireAdmin 了）
      { username: 'am-admin', passwordHash: await hashPassword(PASSWORD), isAdmin: true },
      { username: 'am-member', passwordHash: await hashPassword(PASSWORD), isAdmin: false },
    ])
    .returning({ id: users.id, username: users.username })) as { id: number; username: string }[];

  adminId = inserted.find((u) => u.username === 'am-admin')!.id;
  memberId = inserted.find((u) => u.username === 'am-member')!.id;

  adminCookie = cookieOf(await login('am-admin', PASSWORD));
  memberCookie = cookieOf(await login('am-member', PASSWORD));
  assert.ok(adminCookie.startsWith('lifeos_session='), '管理员应能登录');
  assert.ok(memberCookie.startsWith('lifeos_session='), '普通用户应能登录');
});

after(async () => {
  await db.execute(sql`TRUNCATE users, sessions, audit_logs RESTART IDENTITY CASCADE`);
  await pool.end();
});

describe('账号管理权限', () => {
  it('未登录一律 401；普通用户一律 403（含读列表）', async () => {
    const paths: [string, string][] = [
      ['GET', '/api/users'],
      ['POST', '/api/users'],
      ['POST', `/api/users/${memberId}/disable`],
      ['POST', `/api/users/${memberId}/enable`],
      ['POST', `/api/users/${memberId}/reset-password`],
    ];

    for (const [method, path] of paths) {
      const anon = await app.request(path, { method, headers: { 'content-type': 'application/json' } });
      assert.equal(anon.status, 401, `未登录 ${method} ${path} 应 401`);

      const asMember = await member(path, { method, body: method === 'POST' ? '{}' : undefined });
      assert.equal(asMember.status, 403, `普通用户 ${method} ${path} 应 403`);
    }
  });
});

describe('新增账号', () => {
  it('管理员可新增：返回一次性密码、置为必须改密，新账号默认不是管理员', async () => {
    const res = await admin('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'newbie' }),
    });
    assert.equal(res.status, 201);
    const payload = await body<{
      user: { username: string; isAdmin: boolean; mustChangePassword: boolean; disabled: boolean };
      initialPassword: string;
      notice: string;
    }>(res);

    assert.equal(payload.user.username, 'newbie');
    assert.equal(payload.user.isAdmin, false, '未显式指定时必须默认不是管理员');
    assert.equal(payload.user.mustChangePassword, true, '新账号必须强制首次改密');
    assert.equal(payload.user.disabled, false);
    assert.equal(
      checkPasswordStrength(payload.initialPassword),
      null,
      '系统生成的一次性密码必须满足强度策略，否则用户会在改密页被自己的初始密码卡住',
    );
    assert.match(payload.notice, /只显示这一次/);
  });

  it('显式指定时才是管理员', async () => {
    const res = await admin('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'second-admin', isAdmin: true }),
    });
    assert.equal(res.status, 201);
    const payload = await body<{ user: { isAdmin: boolean } }>(res);
    assert.equal(payload.user.isAdmin, true);
  });

  it('重名被拒（409），非法用户名被拒（400）', async () => {
    assert.equal(
      (await admin('/api/users', { method: 'POST', body: JSON.stringify({ username: 'newbie' }) })).status,
      201,
    );

    const dup = await admin('/api/users', { method: 'POST', body: JSON.stringify({ username: 'newbie' }) });
    assert.equal(dup.status, 409, '重名必须被拒绝而不是覆盖');

    for (const bad of ['ab', 'has space', 'bad/slash', 'a'.repeat(65)]) {
      const res = await admin('/api/users', { method: 'POST', body: JSON.stringify({ username: bad }) });
      assert.equal(res.status, 400, `非法用户名「${bad}」应被拒绝`);
    }
  });
});

describe('禁用与启用', () => {
  it('禁用另一个账号会立刻撤销其全部会话，且该账号无法再登录', async () => {
    // 先确认对方当前能访问业务接口
    assert.equal((await member('/api/events')).status, 200);

    const res = await admin(`/api/users/${memberId}/disable`, { method: 'POST' });
    assert.equal(res.status, 200);

    // 旧 Cookie 立刻失效
    assert.equal((await member('/api/events')).status, 401, '禁用后旧会话必须立刻失效');

    // 重新登录也被拒，且**不暴露"账号被禁用"**（沿用不暴露账号存在性的策略）
    const relogin = await login('am-member', PASSWORD);
    assert.equal(relogin.status, 401);
    const failBody = await body<{ message: string }>(relogin);
    assert.equal(failBody.message, '用户名或密码不正确', '禁用与密码错误必须给出完全相同的措辞');
  });

  it('启用后可以重新登录，但之前失效的会话不会复活', async () => {
    await admin(`/api/users/${memberId}/disable`, { method: 'POST' });
    const res = await admin(`/api/users/${memberId}/enable`, { method: 'POST' });
    assert.equal(res.status, 200);

    assert.equal((await member('/api/events')).status, 401, '旧会话不得复活');
    const relogin = await login('am-member', PASSWORD);
    assert.equal(relogin.status, 200, '启用后应能重新登录');
  });

  it('不能禁用自己（否则会立刻掉线且无法恢复）', async () => {
    const res = await admin(`/api/users/${adminId}/disable`, { method: 'POST' });
    assert.equal(res.status, 409);
    assert.match((await body<{ message: string }>(res)).message, /不能禁用当前登录的账号/);
    assert.equal((await admin('/api/events')).status, 200, '失败后管理员应仍然登录着');
  });

  it('不能禁用唯一启用中的管理员；有第二个管理员后可以', async () => {
    const blocked = await admin(`/api/users/${adminId}/disable`, { method: 'POST' });
    assert.equal(blocked.status, 409);

    // 建第二个管理员，再由它禁用原管理员
    const created = await admin('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin2', isAdmin: true }),
    });
    const created2 = await body<{ user: { id: number }; initialPassword: string }>(created);

    const login2 = await login('admin2', created2.initialPassword);
    assert.equal(login2.status, 200);
    const cookie2 = cookieOf(login2);

    // 第二个管理员自己还没改密，会先被强制改密闸门拦下 → 先改密
    const changed = await as(cookie2)('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: created2.initialPassword, newPassword: 'Second-Admin-Pass-9!' }),
    });
    assert.equal(changed.status, 200, '第二个管理员应能改密');

    const nowAllowed = await as(cookie2)(`/api/users/${adminId}/disable`, { method: 'POST' });
    assert.equal(nowAllowed.status, 200, '有第二个启用中的管理员后，禁用原管理员应被允许');
  });
});

describe('重置密码', () => {
  it('生成一次性密码、强制对方改密、并撤销其全部会话；管理员无法指定密码', async () => {
    assert.equal((await member('/api/events')).status, 200);

    const res = await admin(`/api/users/${memberId}/reset-password`, {
      method: 'POST',
      // 刻意塞一个"指定密码"的字段：接口必须忽略它，不能把管理员的输入当成新密码
      body: JSON.stringify({ newPassword: 'Admin-Chosen-Pass-1!' }),
    });
    assert.equal(res.status, 200);
    const payload = await body<{ initialPassword: string; user: { mustChangePassword: boolean } }>(res);

    assert.equal(payload.user.mustChangePassword, true, '重置后必须强制改密');
    assert.equal(checkPasswordStrength(payload.initialPassword), null);

    assert.equal((await member('/api/events')).status, 401, '重置后旧会话必须全部失效');

    // 管理员指定的那个密码不得生效
    const loginWithChosen = await login('am-member', 'Admin-Chosen-Pass-1!');
    assert.equal(loginWithChosen.status, 401, '服务端不得采纳调用方指定的密码');

    // 一次性密码可以登录，但会被强制改密
    const loginWithIssued = await login('am-member', payload.initialPassword);
    assert.equal(loginWithIssued.status, 200);
  });

  it('对不存在的账号返回 404', async () => {
    const res = await admin('/api/users/999999/reset-password', { method: 'POST' });
    assert.equal(res.status, 404);
  });
});

describe('强制改密闸门（后端，不依赖前端跳转）', () => {
  it('改密之前除「查自己/改密/登出」外一律 403；改密后放行', async () => {
    // 用管理员建一个只能靠一次性密码登录的账号
    const created = await admin('/api/users', { method: 'POST', body: JSON.stringify({ username: 'fresh' }) });
    const { initialPassword } = await body<{ initialPassword: string }>(created);

    const loginRes = await login('fresh', initialPassword);
    assert.equal(loginRes.status, 200);
    const freshCookie = cookieOf(loginRes);
    const fresh = as(freshCookie);

    // 1) 查自己是谁必须可用——否则前端无法知道"我处于必须改密状态"
    const me = await fresh('/api/auth/me');
    assert.equal(me.status, 200, '/auth/me 必须在强制改密期间可用');
    const meBody = await body<{ user: { mustChangePassword: boolean } }>(me);
    assert.equal(meBody.user.mustChangePassword, true);

    // 2) 业务接口一律 403，且给出机器可识别的错误码
    for (const path of [
      '/api/events',
      '/api/tasks?view=today',
      '/api/subscriptions',
      '/api/notifications/jobs',
      '/api/export/data.json',
      '/api/users',
    ]) {
      const res = await fresh(path);
      assert.equal(res.status, 403, `${path} 在未改密时必须被拒绝，实际 ${res.status}`);
      const b = await body<{ error: string }>(res);
      assert.equal(b.error, 'password_change_required', `${path} 的错误码应可被前端识别`);
    }

    // 3) 改密本身可用；但弱密码被拒（这是初始密码可以弱的**前提**）
    const weak = await fresh('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: initialPassword, newPassword: 'Wangliu66' }),
    });
    assert.equal(weak.status, 400, '自助改密必须硬性拒绝弱密码');
    assert.equal((await body<{ error: string }>(weak)).error, 'weak_password');

    // 4) 改了之后立刻放行
    const strong = await fresh('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: initialPassword, newPassword: 'Fresh-Chosen-Pass-7!' }),
    });
    assert.equal(strong.status, 200, `应能改密：${await strong.clone().text()}`);

    const meAfter = await body<{ user: { mustChangePassword: boolean } }>(await fresh('/api/auth/me'));
    assert.equal(meAfter.user.mustChangePassword, false, '改密后标记必须解除');

    assert.equal((await fresh('/api/events')).status, 200, '改密后业务接口必须放行');
  });

  it('改密会撤销该账号在其他设备上的会话，但保留当前设备', async () => {
    const created = await admin('/api/users', { method: 'POST', body: JSON.stringify({ username: 'twice' }) });
    const { initialPassword } = await body<{ initialPassword: string }>(created);

    // 两个"设备"分别登录
    const a = cookieOf(await login('twice', initialPassword));
    const b = cookieOf(await login('twice', initialPassword));
    assert.notEqual(a, b);

    const changed = await as(a)('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: initialPassword, newPassword: 'Twice-Chosen-Pass-7!' }),
    });
    assert.equal(changed.status, 200);

    assert.equal((await as(a)('/api/auth/me')).status, 200, '当前设备的会话必须保留');
    assert.equal((await as(b)('/api/auth/me')).status, 401, '其他设备的会话必须失效');
  });
});

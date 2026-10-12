/**
 * 阶段 2 回归：HTTP 路由集成测试。
 *
 * 直接对真实 Hono 应用发请求（app.request），走完整链路：
 * 认证中间件 → 参数校验 → 数据库 → 通知重调度。
 *
 * 管理员账号建在**测试库**里，密码由本测试自己生成，
 * 不读取、不传播也不重置任何生产凭据。
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { requireTestDatabase } from '../helpers/guard';

requireTestDatabase();

const { db, pool } = await import('../../src/server/db/client');
const { createApp } = await import('../../src/server/app');
const { adminUsers } = await import('../../src/server/db/schema');
const { hashPassword } = await import('../../src/server/lib/password');

const app = createApp();
const TEST_PASSWORD = 'Integration-Test-Pass-1!';

let cookie = '';

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

before(async () => {
  await db.execute(sql`TRUNCATE admin_users, sessions, audit_logs RESTART IDENTITY CASCADE`);
  await db.insert(adminUsers).values({
    username: 'api-test-admin',
    passwordHash: await hashPassword(TEST_PASSWORD),
  });

  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'api-test-admin', password: TEST_PASSWORD }),
  });
  assert.equal(res.status, 200, '测试管理员应能登录');

  const setCookie = res.headers.get('set-cookie') ?? '';
  cookie = setCookie.split(';')[0] ?? '';
  assert.ok(cookie.startsWith('lifeos_session='), `应拿到会话 Cookie，实际：${setCookie}`);
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE notification_attempts, notification_jobs, notification_rules, events, tasks RESTART IDENTITY CASCADE`,
  );
});

after(async () => {
  await db.execute(sql`TRUNCATE admin_users, sessions, audit_logs RESTART IDENTITY CASCADE`);
  await pool.end();
});

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

describe('认证中间件', () => {
  it('未登录访问受保护路由一律 401', async () => {
    const saved = cookie;
    cookie = '';
    try {
      for (const path of [
        '/api/events',
        '/api/tasks?view=today',
        '/api/calendar',
        // V1.1 助手状态同样受保护：它含草稿标题与操作结果
        '/api/wechat/assistant',
      ]) {
        const res = await request(path);
        assert.equal(res.status, 401, `${path} 应要求登录`);
      }
    } finally {
      cookie = saved;
    }
  });

  it('所有 API 响应带 no-store（含 401 与 404）', async () => {
    const saved = cookie;
    cookie = '';
    try {
      const unauth = await request('/api/events');
      assert.match(unauth.headers.get('cache-control') ?? '', /no-store/);
    } finally {
      cookie = saved;
    }

    const notFound = await request('/api/definitely-not-here');
    assert.equal(notFound.status, 404);
    assert.match(notFound.headers.get('cache-control') ?? '', /no-store/, '404 也必须带 no-store');

    const ok = await request('/api/tasks?view=today');
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('cache-control') ?? '', /no-store/);
  });
});

describe('事件 CRUD 与提醒联动', () => {
  it('事件列表分页可遍历全部记录，不会截断较新的事件', async () => {
    for (const [hours, title] of [[1, '第一项'], [2, '第二项'], [3, '第三项']] as const) {
      const created = await request('/api/events', {
        method: 'POST',
        body: JSON.stringify({ title, startAt: inHours(hours) }),
      });
      assert.equal(created.status, 201);
    }
    const first = await json<{ events: { title: string }[]; hasMore: boolean }>(await request('/api/events?limit=2&offset=0'));
    const second = await json<{ events: { title: string }[]; hasMore: boolean }>(await request('/api/events?limit=2&offset=2'));
    assert.deepEqual([...first.events, ...second.events].map((e) => e.title), ['第一项', '第二项', '第三项']);
    assert.equal(first.hasMore, true);
    assert.equal(second.hasMore, false);
    assert.equal((await request('/api/events?limit=0')).status, 400);
  });

  it('创建事件并排提醒，返回创建数量', async () => {
    const res = await request('/api/events', {
      method: 'POST',
      body: JSON.stringify({
        title: '课题组会议',
        startAt: inHours(24),
        location: '科研楼 302',
        reminderEnabled: true,
        reminderOffsets: [60, 10],
      }),
    });
    assert.equal(res.status, 201);
    const body = await json<{ event: { id: string; title: string }; reminder: { created: number } }>(res);
    assert.equal(body.event.title, '课题组会议');
    assert.equal(body.reminder.created, 2);

    const list = await json<{ events: unknown[] }>(await request('/api/events'));
    assert.equal(list.events.length, 1);
  });

  it('结束时间早于开始时间被拒绝', async () => {
    const res = await request('/api/events', {
      method: 'POST',
      body: JSON.stringify({ title: '时间倒置', startAt: inHours(5), endAt: inHours(1) }),
    });
    assert.equal(res.status, 400);
    assert.match((await json<{ message: string }>(res)).message, /结束时间不能早于开始时间/);
  });

  it('空标题被拒绝且给出中文提示', async () => {
    const res = await request('/api/events', {
      method: 'POST',
      body: JSON.stringify({ title: '   ', startAt: inHours(2) }),
    });
    assert.equal(res.status, 400);
    assert.match((await json<{ message: string }>(res)).message, /标题不能为空/);
  });

  it('修改时间后旧提醒失效、新提醒生效', async () => {
    const created = await json<{ event: { id: string } }>(
      await request('/api/events', {
        method: 'POST',
        body: JSON.stringify({
          title: '例会',
          startAt: inHours(24),
          reminderEnabled: true,
          reminderOffsets: [60],
        }),
      }),
    );

    const res = await request(`/api/events/${created.event.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ startAt: inHours(48) }),
    });
    assert.equal(res.status, 200);
    const body = await json<{ reminder: { cancelled: number; created: number } }>(res);
    assert.equal(body.reminder.cancelled, 1, '旧提醒必须失效');
    assert.equal(body.reminder.created, 1, '新提醒必须建立');
  });

  it('取消事件后不再有待发提醒', async () => {
    const created = await json<{ event: { id: string } }>(
      await request('/api/events', {
        method: 'POST',
        body: JSON.stringify({
          title: '待取消',
          startAt: inHours(24),
          reminderEnabled: true,
          reminderOffsets: [60, 10],
        }),
      }),
    );

    const res = await request(`/api/events/${created.event.id}/cancel`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal((await json<{ reminder: { cancelled: number } }>(res)).reminder.cancelled, 2);

    const pending = await db.execute(
      sql`SELECT count(*)::int AS n FROM notification_jobs WHERE status = 'pending'`,
    );
    assert.equal((pending as unknown as { rows: { n: number }[] }).rows[0]!.n, 0);
  });

  it('删除事件后其提醒记录一并清理', async () => {
    const created = await json<{ event: { id: string } }>(
      await request('/api/events', {
        method: 'POST',
        body: JSON.stringify({
          title: '待删除',
          startAt: inHours(24),
          reminderEnabled: true,
          reminderOffsets: [60],
        }),
      }),
    );

    const del = await request(`/api/events/${created.event.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);

    const after404 = await request(`/api/events/${created.event.id}`);
    assert.equal(after404.status, 404);

    const jobs = await db.execute(
      sql`SELECT count(*)::int AS n FROM notification_jobs WHERE subject_id = ${created.event.id}`,
    );
    assert.equal((jobs as unknown as { rows: { n: number }[] }).rows[0]!.n, 0, '不得残留提醒任务');
  });

  it('事件详情返回提醒规则，编辑表单据此回显', async () => {
    const created = await json<{ event: { id: string } }>(
      await request('/api/events', {
        method: 'POST',
        body: JSON.stringify({
          title: '要回显的事件',
          startAt: inHours(24),
          reminderEnabled: true,
          reminderOffsets: [1440, 60, 10],
        }),
      }),
    );

    const detail = await json<{ rule: { enabled: boolean; offsetsMinutes: number[] } | null }>(
      await request(`/api/events/${created.event.id}`),
    );
    assert.ok(detail.rule, '详情必须带 rule 字段');
    assert.equal(detail.rule.enabled, true);
    assert.deepEqual([...detail.rule.offsetsMinutes].sort((a, b) => b - a), [1440, 60, 10]);
  });

  it('编辑事件但不携带提醒字段时，已保存的提醒设置不被覆盖', async () => {
    const created = await json<{ event: { id: string } }>(
      await request('/api/events', {
        method: 'POST',
        body: JSON.stringify({
          title: '只改标题',
          startAt: inHours(24),
          reminderEnabled: true,
          reminderOffsets: [60, 10],
        }),
      }),
    );

    const res = await request(`/api/events/${created.event.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: '改了标题' }),
    });
    assert.equal(res.status, 200);

    const detail = await json<{ rule: { enabled: boolean; offsetsMinutes: number[] } | null }>(
      await request(`/api/events/${created.event.id}`),
    );
    assert.ok(detail.rule);
    assert.equal(detail.rule.enabled, true, '一次普通的编辑不得静默关闭提醒');
    assert.deepEqual([...detail.rule.offsetsMinutes].sort((a, b) => b - a), [60, 10]);
  });

  it('编辑事件并显式关闭提醒时，规则更新且未发送提醒被取消', async () => {
    const created = await json<{ event: { id: string } }>(
      await request('/api/events', {
        method: 'POST',
        body: JSON.stringify({
          title: '要关提醒的事件',
          startAt: inHours(24),
          reminderEnabled: true,
          reminderOffsets: [60, 10],
        }),
      }),
    );

    const res = await request(`/api/events/${created.event.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ reminderEnabled: false }),
    });
    assert.equal(res.status, 200);
    assert.equal((await json<{ reminder: { cancelled: number } }>(res)).reminder.cancelled, 2);

    const detail = await json<{ rule: { enabled: boolean } | null }>(
      await request(`/api/events/${created.event.id}`),
    );
    assert.equal(detail.rule?.enabled, false, '显式关闭必须生效');
  });
});

describe('待办 CRUD 与提醒约束', () => {
  it('创建全天待办（有日期无时刻）成功', async () => {
    const res = await request('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: '提交周报', dueDate: '2030-06-15' }),
    });
    assert.equal(res.status, 201);
    const body = await json<{ task: { dueDate: string; dueTime: string | null } }>(res);
    assert.equal(body.task.dueDate, '2030-06-15');
    assert.equal(body.task.dueTime, null);
  });

  it('全天待办要求精确提醒被拒绝（PRD FR-02）', async () => {
    const res = await request('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: '全天待办带提醒',
        dueDate: '2030-06-15',
        reminderEnabled: true,
        reminderOffsets: [60],
      }),
    });
    assert.equal(res.status, 400);
    assert.match((await json<{ message: string }>(res)).message, /具体时刻/);
  });

  it('只填时刻不填日期被拒绝', async () => {
    const res = await request('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: '缺日期', dueTime: '09:00' }),
    });
    assert.equal(res.status, 400);
  });

  it('非法日期（2030-02-30）被拒绝', async () => {
    const res = await request('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: '假日期', dueDate: '2030-02-30' }),
    });
    assert.equal(res.status, 400);
    assert.match((await json<{ message: string }>(res)).message, /不是合法日期/);
  });

  it('有日期与时刻的待办可排提醒', async () => {
    const res = await request('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: '交材料',
        dueDate: '2030-06-15',
        dueTime: '15:00',
        reminderEnabled: true,
        reminderOffsets: [60, 10],
      }),
    });
    assert.equal(res.status, 201);
    assert.equal((await json<{ reminder: { created: number } }>(res)).reminder.created, 2);
  });

  it('完成待办后状态变为 done 且取消未发送提醒', async () => {
    const created = await json<{ task: { id: string } }>(
      await request('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: '完成任务',
          dueDate: '2030-06-15',
          dueTime: '15:00',
          reminderEnabled: true,
          reminderOffsets: [60],
        }),
      }),
    );

    const res = await request(`/api/tasks/${created.task.id}/complete`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await json<{ task: { status: string }; reminder: { cancelled: number } }>(res);
    assert.equal(body.task.status, 'done');
    assert.equal(body.reminder.cancelled, 1);
  });

  it('无截止日期的待办进入收件箱', async () => {
    await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: '随手记' }) });

    const inbox = await json<{ tasks: unknown[] }>(await request('/api/tasks?view=inbox'));
    assert.equal(inbox.tasks.length, 1);

    const upcoming = await json<{ tasks: unknown[] }>(await request('/api/tasks?view=upcoming'));
    assert.equal(upcoming.tasks.length, 0);
  });

  it('计数接口返回四个视图的数量', async () => {
    await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: '无日期' }) });
    await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: '未来', dueDate: '2030-06-15' }) });

    const res = await request('/api/tasks/counts');
    const body = await json<{ counts: { inbox: number; upcoming: number } }>(res);
    assert.equal(body.counts.inbox, 1);
    assert.equal(body.counts.upcoming, 1);
  });

  it('「今天」视图不含无日期待办，且与计数同口径', async () => {
    await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: '无日期' }) });
    await request('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: '今天到期', dueDate: new Date().toISOString().slice(0, 10) }),
    });

    const list = await json<{ tasks: { title: string }[] }>(await request('/api/tasks?view=today'));
    assert.deepEqual(
      list.tasks.map((t) => t.title),
      ['今天到期'],
      '无日期的待办只属于收件箱，不得混入今天视图',
    );

    const counts = await json<{ counts: { today: number } }>(await request('/api/tasks/counts'));
    assert.equal(counts.counts.today, list.tasks.length, '列表与计数必须是同一口径');
  });

  it('待办详情返回提醒规则，编辑不携带提醒字段时不覆盖原设置', async () => {
    const created = await json<{ task: { id: string } }>(
      await request('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: '要回显的待办',
          dueDate: '2030-06-15',
          dueTime: '15:00',
          reminderEnabled: true,
          reminderOffsets: [1440],
        }),
      }),
    );

    const detail = await json<{ rule: { enabled: boolean; offsetsMinutes: number[] } | null }>(
      await request(`/api/tasks/${created.task.id}`),
    );
    assert.ok(detail.rule, '详情必须带 rule 字段');
    assert.equal(detail.rule.enabled, true);
    assert.deepEqual(detail.rule.offsetsMinutes, [1440]);

    const res = await request(`/api/tasks/${created.task.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: '改个名字而已' }),
    });
    assert.equal(res.status, 200);

    const after = await json<{ rule: { enabled: boolean; offsetsMinutes: number[] } | null }>(
      await request(`/api/tasks/${created.task.id}`),
    );
    assert.ok(after.rule);
    assert.equal(after.rule.enabled, true, '普通编辑不得静默关闭提醒');
    assert.deepEqual(after.rule.offsetsMinutes, [1440]);
  });
});

describe('日历聚合读视图', () => {
  it('聚合事件与带日期的待办，并给出按天计数', async () => {
    await request('/api/events', {
      method: 'POST',
      body: JSON.stringify({ title: '聚合事件', startAt: inHours(24) }),
    });
    await request('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: '聚合待办', dueDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) }),
    });

    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const res = await request(`/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    assert.equal(res.status, 200);

    const body = await json<{ items: { type: string; title: string }[] }>(res);
    const types = body.items.map((i) => i.type).sort();
    assert.deepEqual(types, ['event', 'task'], '事件与待办都应出现');
  });

  it('无截止日期的待办不出现在日历中（它在收件箱）', async () => {
    await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: '无日期待办' }) });

    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const body = await json<{ items: unknown[] }>(
      await request(`/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    );
    assert.equal(body.items.length, 0);
  });

  it('时间范围倒置被拒绝', async () => {
    const res = await request(
      `/api/calendar?from=${encodeURIComponent(inHours(48))}&to=${encodeURIComponent(inHours(1))}`,
    );
    assert.equal(res.status, 400);
  });

  it('过大的时间跨度被拒绝（避免拉走整库）', async () => {
    const res = await request(
      `/api/calendar?from=${encodeURIComponent('2020-01-01T00:00:00.000Z')}&to=${encodeURIComponent('2030-01-01T00:00:00.000Z')}`,
    );
    assert.equal(res.status, 400);
    assert.match((await json<{ message: string }>(res)).message, /跨度不能超过/);
  });

  it('总览接口返回今日到期与逾期未完成的待办', async () => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await request('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: '今天到期', dueDate: todayStr }),
    });
    await request('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: '已逾期未完成', dueDate: yesterday }),
    });
    await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: '无日期' }) });

    const body = await json<{
      today: string;
      tasksDueTodayCount: number;
      tasksDueToday: { title: string }[];
    }>(await request('/api/calendar/overview'));

    assert.equal(body.tasksDueTodayCount, 2, '今天到期 + 逾期未完成；无日期待办不算');
    assert.ok(
      body.tasksDueToday.some((t) => t.title === '已逾期未完成'),
      '逾期未完成的待办必须出现在总览里',
    );
    assert.ok(!body.tasksDueToday.some((t) => t.title === '无日期'), '无日期待办留在待办页收件箱');
  });
});

describe('V1.1 助手状态端点', () => {
  it('已登录时返回草稿、最近操作、计数与开关，且不含凭据', async () => {
    const res = await request('/api/wechat/assistant');
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;

    // 契约字段齐备
    for (const key of [
      'inboundEnabled',
      'modelCallsEnabled',
      'draft',
      'recent',
      'recentReplies',
      'inboundCounts',
      'outboxCounts',
      'listenerAt',
      'listenerError',
    ]) {
      assert.ok(key in body, `缺少字段 ${key}`);
    }

    assert.equal(typeof body.inboundEnabled, 'boolean');
    assert.equal(typeof body.modelCallsEnabled, 'boolean');
    assert.ok(Array.isArray(body.recent));
    assert.ok(Array.isArray(body.recentReplies));
    assert.equal(typeof body.inboundCounts, 'object');

    // 绝不能泄漏凭据或私有状态
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /bot_token|account|context|Authorization|Bearer/i, '不得包含凭据字段');
    assert.doesNotMatch(text, /apikey_/, '不得包含密钥');
  });
});
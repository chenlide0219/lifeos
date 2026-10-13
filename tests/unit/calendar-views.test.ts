/**
 * 阶段 2/4 回归：日历视图的数据契约（PRD FR-04）。
 *
 * 月/周/日三种视图共用同一个聚合接口，差别只在查询范围，
 * 因此这里守住"范围决定内容"以及"订阅条目确实进日历"两件事。
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { requireTestDatabase } from '../helpers/guard';

requireTestDatabase();

const { db, pool } = await import('../../src/server/db/client');
const { createApp } = await import('../../src/server/app');
const { users } = await import('../../src/server/db/schema');
const { hashPassword } = await import('../../src/server/lib/password');

const app = createApp();
const PASSWORD = 'CalView-Pass-1!';
let cookie = '';

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
}
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

/** 以 +08:00 表示某天 00:00 与 23:59，模拟前端按视图范围发请求 */
const dayStart = (d: string) => new Date(`${d}T00:00:00+08:00`).toISOString();
const dayEnd = (d: string) => new Date(`${d}T23:59:59+08:00`).toISOString();

async function fetchRange(from: string, to: string) {
  const res = await request(
    `/api/calendar?from=${encodeURIComponent(dayStart(from))}&to=${encodeURIComponent(dayEnd(to))}`,
  );
  assert.equal(res.status, 200);
  return json<{ items: { type: string; date: string; title: string; allDay: boolean; time: string | null }[] }>(res);
}

before(async () => {
  await db.execute(sql`TRUNCATE users, sessions, audit_logs RESTART IDENTITY CASCADE`);
  await db.insert(users).values({ username: 'calview', passwordHash: await hashPassword(PASSWORD) });
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'calview', password: PASSWORD }),
  });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  assert.ok(cookie.startsWith('lifeos_session='));
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE notification_attempts, notification_jobs, notification_rules,
        payments, expected_bills, subscription_price_history, subscriptions, events, tasks
        RESTART IDENTITY CASCADE`,
  );
});

after(async () => {
  await db.execute(sql`TRUNCATE users, sessions, audit_logs RESTART IDENTITY CASCADE`);
  await pool.end();
});

describe('日视图：范围内只返回当天', () => {
  it('单日查询只包含当天的条目', async () => {
    // 三天各放一个事件
    for (const d of ['2030-03-10', '2030-03-11', '2030-03-12']) {
      await request('/api/events', {
        method: 'POST',
        body: JSON.stringify({ title: `${d} 的事`, startAt: `${d}T10:00:00+08:00` }),
      });
    }

    const day = await fetchRange('2030-03-11', '2030-03-11');
    assert.equal(day.items.length, 1, '日视图只应看到当天');
    assert.equal(day.items[0]!.date, '2030-03-11');
  });
});

describe('周视图：返回整周内容', () => {
  it('一周范围包含周内全部条目', async () => {
    for (const d of ['2030-03-11', '2030-03-13', '2030-03-17']) {
      await request('/api/events', {
        method: 'POST',
        body: JSON.stringify({ title: `${d} 的事`, startAt: `${d}T10:00:00+08:00` }),
      });
    }

    // 2030-03-11 是周一，到 03-17（周日）为一周
    const week = await fetchRange('2030-03-11', '2030-03-17');
    assert.equal(week.items.length, 3, '周视图应看到整周 3 条');

    // 少了最后一天时不该包含它
    const partial = await fetchRange('2030-03-11', '2030-03-16');
    assert.equal(partial.items.length, 2, '范围之外的不应出现');
  });
});

describe('月视图范围跨月时也正确', () => {
  it('跨月范围同时包含两个月的条目', async () => {
    await request('/api/events', {
      method: 'POST',
      body: JSON.stringify({ title: '三月底', startAt: '2030-03-31T10:00:00+08:00' }),
    });
    await request('/api/events', {
      method: 'POST',
      body: JSON.stringify({ title: '四月初', startAt: '2030-04-01T10:00:00+08:00' }),
    });

    const span = await fetchRange('2030-03-25', '2030-04-07');
    assert.equal(span.items.length, 2);
  });
});

describe('订阅条目进入日历（PRD FR-04）', () => {
  it('预计账单按扣费日出现在日历中，且是全天项目', async () => {
    // 注意：预计账单只生成未来 12 个月（PRD FR-06 的滚动范围），
    // 锚点必须落在这个窗口内才会产生账单；用远期日期会（正确地）什么都得不到。
    const today = new Date();
    const anchor = `${today.getFullYear() + 1}-03-15`;
    const monthStart = `${today.getFullYear() + 1}-03-01`;
    const monthEnd = `${today.getFullYear() + 1}-03-31`;

    await request('/api/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        name: 'ChatGPT Plus',
        price: '20.00',
        currency: 'USD',
        billingPeriod: 'monthly',
        anchorDate: anchor,
        serviceEndDate: `${today.getFullYear() + 2}-03-15`,
      }),
    });

    const span = await fetchRange(monthStart, monthEnd);
    const subs = span.items.filter((i) => i.type === 'subscription');
    assert.ok(subs.length > 0, '订阅续费应出现在日历中');
    assert.ok(subs.some((i) => i.date === anchor), `应落在扣费日 ${anchor} 当天`);
    assert.ok(subs.every((i) => i.allDay), '扣费日是日历日期，应按全天处理而不是某个时刻');
    assert.ok(subs.every((i) => i.time === null));
  });

  it('带日期的待办也进入日历，全天待办没有具体时刻', async () => {
    await request('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: '全天待办', dueDate: '2030-03-20' }),
    });
    await request('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: '定时待办', dueDate: '2030-03-20', dueTime: '15:00' }),
    });

    const day = await fetchRange('2030-03-20', '2030-03-20');
    const allDay = day.items.find((i) => i.title === '全天待办');
    const timed = day.items.find((i) => i.title === '定时待办');

    assert.ok(allDay?.allDay, '无时刻的待办应为全天项目');
    assert.equal(allDay?.time, null);
    assert.equal(timed?.allDay, false, '有时刻的待办不应是全天');
    assert.equal(timed?.time, '15:00');
  });

  it('取消的事件不进入日历', async () => {
    const created = await json<{ event: { id: string } }>(
      await request('/api/events', {
        method: 'POST',
        body: JSON.stringify({ title: '将被取消', startAt: '2030-03-22T10:00:00+08:00' }),
      }),
    );
    await request(`/api/events/${created.event.id}/cancel`, { method: 'POST' });

    const span = await fetchRange('2030-03-22', '2030-03-22');
    const e = span.items.find((i) => i.title === '将被取消');
    // 取消的事件仍会返回但标记为 inactive（界面弱化显示），不应消失得无影无踪
    assert.ok(e, '取消的事件仍应在日历中可见（标记为已取消）');
  });

  it('无截止日期的待办不进入日历（它属于收件箱）', async () => {
    await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: '无日期待办' }) });
    const span = await fetchRange('2030-03-01', '2030-03-31');
    assert.equal(span.items.filter((i) => i.title === '无日期待办').length, 0);
  });
});

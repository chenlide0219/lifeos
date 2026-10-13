/**
 * 阶段 4 回归：订阅汇总接口（PRD FR-06 口径分离）。
 *
 * 重点守住"即将扣费"列表的语义：已结束/已暂停的订阅**不会**真的扣费，
 * 不该出现在待扣费提醒里；关闭自动续费的则要能被区分出来。
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
const PASSWORD = 'SubSum-Pass-1!';
let cookie = '';

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
}

type Summary = {
  expected: { monthlyByCurrency: Record<string, number> };
  actual: { currency: string; net: string }[];
  upcoming: { name: string; date: string; amount: string; currency: string; autoRenew: boolean }[];
  expectedMonthly: string;
  subscriptions: number;
};

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

/** 一个月后的日期，保证落在"即将扣费"窗口内 */
function nextMonth(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

before(async () => {
  await db.execute(sql`TRUNCATE users, sessions, audit_logs RESTART IDENTITY CASCADE`);
  await db.insert(users).values({ username: 'subsum', passwordHash: await hashPassword(PASSWORD) });
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'subsum', password: PASSWORD }),
  });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  assert.ok(cookie.startsWith('lifeos_session='));
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE notification_attempts, notification_jobs, notification_rules,
        payments, expected_bills, subscription_price_history, subscriptions
        RESTART IDENTITY CASCADE`,
  );
});

after(async () => {
  await db.execute(sql`TRUNCATE users, sessions, audit_logs RESTART IDENTITY CASCADE`);
  await pool.end();
});

async function createSub(body: Record<string, unknown>) {
  const res = await request('/api/subscriptions', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(res.status, 201, `创建应成功：${await res.text()}`);
}

const base = () => ({
  name: 'ChatGPT Plus',
  price: '20.00',
  currency: 'USD',
  billingPeriod: 'monthly',
  anchorDate: '2026-01-15',
  nextBillingDate: nextMonth(),
  serviceEndDate: '2030-12-31',
});

describe('即将扣费列表的语义', () => {
  it('有效订阅出现在待扣费列表，并带上自动续费状态', async () => {
    await createSub(base());
    const summary = await json<Summary>(await request('/api/subscriptions/summary'));

    assert.equal(summary.upcoming.length, 1);
    assert.equal(summary.upcoming[0]!.name, 'ChatGPT Plus');
    assert.equal(summary.upcoming[0]!.autoRenew, true);
  });

  it('关闭自动续费的订阅仍出现，但明确标记为不会自动续费', async () => {
    await createSub({ ...base(), autoRenew: false, status: 'auto_renew_off' });
    const summary = await json<Summary>(await request('/api/subscriptions/summary'));

    assert.equal(summary.upcoming.length, 1);
    assert.equal(summary.upcoming[0]!.autoRenew, false, '界面必须能区分"不会真的扣费"');
  });

  it('汇总不截断前十项，避免隐藏后续真正待扣费的订阅', async () => {
    for (let i = 0; i < 10; i++) {
      await createSub({ ...base(), name: `不再续费 ${i}`, autoRenew: false, status: 'auto_renew_off' });
    }
    await createSub({ ...base(), name: '仍会扣费' });
    const summary = await json<Summary>(await request('/api/subscriptions/summary'));
    assert.equal(summary.upcoming.length, 11);
    assert.ok(summary.upcoming.some((s) => s.name === '仍会扣费' && s.autoRenew));
  });

  it('已结束的订阅不出现在待扣费列表（它不会再扣费）', async () => {
    await createSub({ ...base(), name: '已结束的服务', status: 'ended' });
    const summary = await json<Summary>(await request('/api/subscriptions/summary'));
    assert.equal(summary.upcoming.length, 0);
  });

  it('已暂停的订阅不出现在待扣费列表', async () => {
    await createSub({ ...base(), name: '已暂停的服务', status: 'paused' });
    const summary = await json<Summary>(await request('/api/subscriptions/summary'));
    assert.equal(summary.upcoming.length, 0);
  });

  it('已过扣费日的不出现在待扣费列表', async () => {
    await createSub({ ...base(), nextBillingDate: '2020-01-15' });
    const summary = await json<Summary>(await request('/api/subscriptions/summary'));
    assert.equal(summary.upcoming.length, 0, '过去的日期不是"即将扣费"');
  });
});

describe('两套口径严格分离', () => {
  it('预计月均只统计订阅推算，未付任何款时实付为空', async () => {
    await createSub(base());
    const summary = await json<Summary>(await request('/api/subscriptions/summary'));

    assert.equal(summary.expectedMonthly, '20.00', '月付 20 的月均就是 20');
    assert.equal(summary.actual.length, 0, '尚无实付，实付口径必须为空');
  });

  it('确认付款后实付口径出现数据，预计口径不受影响', async () => {
    await createSub(base());
    const bills = await json<{ bills: { id: string }[] }>(
      await request('/api/subscriptions/bills/list?status=expected'),
    );
    assert.ok(bills.bills.length > 0);

    await request(`/api/subscriptions/bills/${bills.bills[0]!.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ amount: '20.00' }),
    });

    const summary = await json<Summary>(await request('/api/subscriptions/summary'));
    assert.equal(summary.expectedMonthly, '20.00', '预计口径不因付款而改变');
    const usd = summary.actual.find((a) => a.currency === 'USD');
    assert.ok(usd, '实付口径应出现 USD');
    assert.equal(usd!.net, '20.00');
  });

  it('多币种分别归集，不跨币种相加', async () => {
    await createSub(base());
    await createSub({ ...base(), name: '国内服务', price: '30.00', currency: 'CNY' });

    const summary = await json<Summary>(await request('/api/subscriptions/summary'));
    assert.equal(summary.expected.monthlyByCurrency.USD, 20);
    assert.equal(summary.expected.monthlyByCurrency.CNY, 30);
  });
});

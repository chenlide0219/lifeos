/**
 * 阶段 4 回归：订阅财务的不变量（PRD FR-06）。
 *
 * 最要紧的一条：**预计账单永不自动转为真实支出**。
 * 生成账单、读取、统计都不得产生 payments 记录；
 * 只有用户显式确认付款才会生成，且不能重复确认。
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
const PASSWORD = 'Sub-Test-Pass-1!';
let cookie = '';

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
}

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

async function countPayments(): Promise<number> {
  const r = (await db.execute(sql`SELECT count(*)::int AS n FROM payments`)) as unknown as {
    rows: { n: number }[];
  };
  return r.rows[0]!.n;
}

before(async () => {
  await db.execute(sql`TRUNCATE admin_users, sessions, audit_logs RESTART IDENTITY CASCADE`);
  await db.insert(adminUsers).values({ username: 'sub-test', passwordHash: await hashPassword(PASSWORD) });
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'sub-test', password: PASSWORD }),
  });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  assert.ok(cookie.startsWith('lifeos_session='));
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE payments, expected_bills, subscription_price_history, subscriptions RESTART IDENTITY CASCADE`,
  );
});

after(async () => {
  await db.execute(sql`TRUNCATE admin_users, sessions, audit_logs RESTART IDENTITY CASCADE`);
  await pool.end();
});

async function createSub(overrides: Record<string, unknown> = {}) {
  const res = await request('/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      name: 'ChatGPT Plus',
      price: '20.00',
      currency: 'USD',
      billingPeriod: 'monthly',
      anchorDate: '2026-01-31',
      serviceEndDate: '2027-01-31',
      autoRenew: true,
      ...overrides,
    }),
  });
  return { res, body: await json<{ subscription: { id: string }; expectedBills: { created: number } }>(res) };
}

describe('档案创建与预计账单生成', () => {
  it('创建订阅后按规则生成预计账单，但**不产生任何付款记录**', async () => {
    const { res, body } = await createSub();
    assert.equal(res.status, 201);
    assert.equal(body.expectedBills.created, 12, '应生成 12 个月的滚动预计账单');

    assert.equal(await countPayments(), 0, '生成账单绝不能产生付款记录 —— 这是核心不变量');
  });

  it('月末锚点生成的账单日期符合夹取规则', async () => {
    // 锚点必须在未来：预计账单只生成今天及以后的（过去的由实付记录负责）
    await createSub({ anchorDate: '2027-01-31', serviceEndDate: null });
    const res = await request('/api/subscriptions/bills/list');
    const body = await json<{ bills: { plannedDate: string }[] }>(res);
    const dates = body.bills.map((b) => b.plannedDate).sort();
    assert.ok(dates.includes('2027-02-28'), `2 月应夹取到 28 日，实际：${dates.slice(0, 4).join(',')}`);
    assert.ok(dates.includes('2027-04-30'), '4 月应夹取到 30 日');
    assert.ok(dates.includes('2027-03-31'), '夹取后下个月应回到原始日 31 日');
  });

  it('缺少计费锚点的非终身订阅被拒绝', async () => {
    const res = await request('/api/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', price: '10', billingPeriod: 'monthly', anchorDate: null }),
    });
    assert.equal(res.status, 400);
    assert.match((await json<{ message: string }>(res)).message, /计费锚点/);
  });

  it('自动续费关闭的订阅只生成到服务到期日', async () => {
    const { body } = await createSub({
      autoRenew: false,
      status: 'auto_renew_off',
      anchorDate: '2026-01-15',
      serviceEndDate: '2026-03-31',
    });
    assert.ok(body.expectedBills.created <= 3, `不应外推到到期日之后，实际 ${body.expectedBills.created}`);
  });
});

describe('确认付款：预计 → 实付的唯一入口', () => {
  it('确认后生成独立付款记录并关联账单', async () => {
    await createSub();
    const list = await json<{ bills: { id: string; status: string }[] }>(
      await request('/api/subscriptions/bills/list?status=expected'),
    );
    const bill = list.bills[0]!;

    const res = await request(`/api/subscriptions/bills/${bill.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ paidAt: '2026-01-31', amount: '20.00' }),
    });
    assert.equal(res.status, 201);

    const body = await json<{ payment: { id: string; expectedBillId: string; isRefund: boolean }; bill: { status: string } }>(res);
    assert.equal(body.bill.status, 'confirmed');
    assert.equal(body.payment.expectedBillId, bill.id, '付款必须关联到来源账单');
    assert.equal(body.payment.isRefund, false);
    assert.equal(await countPayments(), 1);
  });

  it('重复确认同一账单被拒绝（否则会产生重复支出）', async () => {
    await createSub();
    const list = await json<{ bills: { id: string }[] }>(
      await request('/api/subscriptions/bills/list?status=expected'),
    );
    const bill = list.bills[0]!;

    const first = await request(`/api/subscriptions/bills/${bill.id}/confirm`, { method: 'POST', body: '{}' });
    assert.equal(first.status, 201);

    const second = await request(`/api/subscriptions/bills/${bill.id}/confirm`, { method: 'POST', body: '{}' });
    assert.equal(second.status, 409);
    assert.equal(await countPayments(), 1, '重复确认不得产生第二笔支出');
  });

  it('跳过的账单不能被确认付款', async () => {
    await createSub();
    const list = await json<{ bills: { id: string }[] }>(
      await request('/api/subscriptions/bills/list?status=expected'),
    );
    const bill = list.bills[0]!;
    assert.equal((await request(`/api/subscriptions/bills/${bill.id}/skip`, { method: 'POST' })).status, 200);
    assert.equal(
      (await request(`/api/subscriptions/bills/${bill.id}/confirm`, { method: 'POST', body: '{}' })).status,
      409,
    );
    assert.equal(await countPayments(), 0);
  });

  it('读取账单与统计都不会改变已付状态或产生付款', async () => {
    await createSub();
    await request('/api/subscriptions/bills/list');
    await request('/api/subscriptions/summary');
    await request('/api/subscriptions/analytics/summary');
    assert.equal(await countPayments(), 0, '读操作绝不产生支出');
  });
});

describe('手动记账与退款', () => {
  it('可以不依赖预计账单直接记账', async () => {
    const res = await request('/api/subscriptions/payments', {
      method: 'POST',
      body: JSON.stringify({ paidAt: '2026-02-01', amount: '45.50', currency: 'CNY', note: '补录' }),
    });
    assert.equal(res.status, 201);
    assert.equal(await countPayments(), 1);
  });

  it('退款作为独立记录，统计时从净支出中扣减', async () => {
    const pay = await json<{ payment: { id: string } }>(
      await request('/api/subscriptions/payments', {
        method: 'POST',
        body: JSON.stringify({ paidAt: '2026-02-01', amount: '100.00', currency: 'CNY' }),
      }),
    );

    const refundRes = await request(`/api/subscriptions/payments/${pay.payment.id}/refund`, {
      method: 'POST',
      body: JSON.stringify({ amount: '30.00' }),
    });
    assert.equal(refundRes.status, 201);

    const summary = await json<{ actualNet: { currency: string; gross: string; refunds: string; net: string }[] }>(
      await request('/api/subscriptions/analytics/summary'),
    );
    const cny = summary.actualNet.find((r) => r.currency === 'CNY')!;
    assert.equal(cny.gross, '100.00');
    assert.equal(cny.refunds, '30.00');
    assert.equal(cny.net, '70.00', '净支出必须扣减退款');
  });

  it('退款金额不得超过原付款', async () => {
    const pay = await json<{ payment: { id: string } }>(
      await request('/api/subscriptions/payments', {
        method: 'POST',
        body: JSON.stringify({ paidAt: '2026-02-01', amount: '50.00', currency: 'CNY' }),
      }),
    );
    const res = await request(`/api/subscriptions/payments/${pay.payment.id}/refund`, {
      method: 'POST',
      body: JSON.stringify({ amount: '80.00' }),
    });
    assert.equal(res.status, 400);
  });

  it('退款记录不能再被退款', async () => {
    const pay = await json<{ payment: { id: string } }>(
      await request('/api/subscriptions/payments', {
        method: 'POST',
        body: JSON.stringify({ paidAt: '2026-02-01', amount: '50.00', currency: 'CNY' }),
      }),
    );
    const refund = await json<{ refund: { id: string } }>(
      await request(`/api/subscriptions/payments/${pay.payment.id}/refund`, { method: 'POST', body: '{}' }),
    );
    const second = await request(`/api/subscriptions/payments/${refund.refund.id}/refund`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(second.status, 409);
  });

  it('非法币种被拒绝', async () => {
    const res = await request('/api/subscriptions/payments', {
      method: 'POST',
      body: JSON.stringify({ paidAt: '2026-02-01', amount: '10', currency: 'RMB' }),
    });
    assert.equal(res.status, 400);
  });
});

describe('调价不追改历史付款', () => {
  it('修改价格后已确认的旧付款金额保持不变，并留下价格历史', async () => {
    const { body } = await createSub({ price: '20.00' });
    const subId = body.subscription.id;

    const list = await json<{ bills: { id: string }[] }>(
      await request('/api/subscriptions/bills/list?status=expected'),
    );
    await request(`/api/subscriptions/bills/${list.bills[0]!.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ amount: '20.00' }),
    });

    // 调价
    const patched = await request(`/api/subscriptions/${subId}`, {
      method: 'PATCH',
      body: JSON.stringify({ price: '25.00' }),
    });
    assert.equal(patched.status, 200);

    const detail = await json<{
      priceHistory: { price: string }[];
      payments: { amount: string }[];
    }>(await request(`/api/subscriptions/${subId}`));

    assert.equal(detail.payments[0]!.amount, '20.00', '历史付款金额不得被追改');
    assert.ok(detail.priceHistory.length >= 2, '应有初始价格与调价两条历史');
    assert.ok(detail.priceHistory.some((h) => h.price === '25.00'));
  });
});

describe('统计口径分离', () => {
  it('预计与实付分开返回，且附带不可混算的说明', async () => {
    await createSub();
    const summary = await json<{
      expected: { amount: string; count: number }[];
      actualNet: unknown[];
      disclaimer: string;
    }>(await request('/api/subscriptions/analytics/summary'));

    assert.ok(summary.expected.length > 0, '预计口径应有数据');
    assert.equal(summary.actualNet.length, 0, '尚无实付，实付口径应为空');
    assert.match(summary.disclaimer, /不可相加/);
  });
});

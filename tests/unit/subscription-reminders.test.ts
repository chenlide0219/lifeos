/**
 * 阶段 4/5 回归：订阅提醒（PRD FR-05 / FR-07）。
 *
 * 此前 subscriptions 表上的 reminder_enabled / reminder_days_before / reminder_time
 * 是**死字段**——从未被任何代码读取，订阅提醒完全没接进通知调度。
 * 这里逐条守住接入后的语义。
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { requireTestDatabase } from '../helpers/guard';

requireTestDatabase();

const { db, pool } = await import('../../src/server/db/client');
const { createApp } = await import('../../src/server/app');
const { adminUsers, notificationJobs, subscriptionPriceHistory, subscriptions } = await import(
  '../../src/server/db/schema'
);
const { hashPassword } = await import('../../src/server/lib/password');

const app = createApp();
const PASSWORD = 'SubRemind-Pass-1!';
let cookie = '';

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
}
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

before(async () => {
  await db.execute(sql`TRUNCATE admin_users, sessions, audit_logs RESTART IDENTITY CASCADE`);
  await db.insert(adminUsers).values({ username: 'subremind', passwordHash: await hashPassword(PASSWORD) });
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'subremind', password: PASSWORD }),
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
      anchorDate: '2030-06-15',
      serviceEndDate: '2030-12-31',
      autoRenew: true,
      reminderEnabled: false,
      ...overrides,
    }),
  });
  assert.equal(res.status, 201, `创建订阅应成功，实际 ${res.status}`);
  const body = await json<{ subscription: { id: string }; reminder: { created: number } }>(res);
  return body;
}

async function jobsOf(subscriptionId: string) {
  return db
    .select({
      id: notificationJobs.id,
      title: notificationJobs.title,
      body: notificationJobs.body,
      fireAt: notificationJobs.fireAt,
      status: notificationJobs.status,
      idempotencyKey: notificationJobs.idempotencyKey,
    })
    .from(notificationJobs)
    .where(and(eq(notificationJobs.subjectType, 'subscription'), eq(notificationJobs.subjectId, subscriptionId)))
    .orderBy(notificationJobs.fireAt);
}

describe('订阅提醒：接入前是死字段，接入后必须生效', () => {
  it('未开启提醒时不排提醒', async () => {
    const { subscription } = await createSub({ reminderEnabled: false });
    assert.equal((await jobsOf(subscription.id)).length, 0);
  });

  it('开启提醒后按提前天数与发送时刻排出提醒', async () => {
    const { subscription, reminder } = await createSub({
      reminderEnabled: true,
      reminderDaysBefore: 3,
      reminderTime: '09:00',
      nextBillingDate: '2030-06-15',
    });

    assert.equal(reminder.created, 1, '应排出 1 条订阅提醒');
    const jobs = await jobsOf(subscription.id);
    assert.equal(jobs.length, 1);

    // 2030-06-15 提前 3 天 = 2030-06-12 09:00 Asia/Shanghai = 01:00Z
    assert.equal(jobs[0]!.fireAt.toISOString(), '2030-06-12T01:00:00.000Z');
    assert.match(jobs[0]!.title, /即将扣费/);
    assert.match(jobs[0]!.body, /2030-06-15/);
    assert.match(jobs[0]!.body, /提前 3 天/);
    assert.equal(jobs[0]!.status, 'pending');
  });

  it('提前天数为 0 时在扣费当天指定时刻提醒', async () => {
    const { subscription } = await createSub({
      reminderEnabled: true,
      reminderDaysBefore: 0,
      reminderTime: '08:30',
      nextBillingDate: '2030-06-15',
    });
    const jobs = await jobsOf(subscription.id);
    assert.equal(jobs[0]!.fireAt.toISOString(), '2030-06-15T00:30:00.000Z');
  });
});

describe('自动续费关闭时改为提醒到期', () => {
  it('提醒对象变成服务到期日，而不是下一次扣费', async () => {
    const { subscription } = await createSub({
      autoRenew: false,
      status: 'auto_renew_off',
      reminderEnabled: true,
      reminderDaysBefore: 7,
      reminderTime: '10:00',
      nextBillingDate: '2030-06-15',
      serviceEndDate: '2030-12-31',
    });

    const jobs = await jobsOf(subscription.id);
    assert.equal(jobs.length, 1);
    assert.match(jobs[0]!.title, /即将到期/);
    assert.match(jobs[0]!.body, /2030-12-31/, '应针对服务到期日而不是扣费日');
    // 2030-12-31 提前 7 天 = 2030-12-24 10:00 CST = 02:00Z
    assert.equal(jobs[0]!.fireAt.toISOString(), '2030-12-24T02:00:00.000Z');
  });
});

describe('不排提醒的情形', () => {
  it('已结束的订阅不排提醒', async () => {
    const { subscription } = await createSub({
      status: 'ended',
      reminderEnabled: true,
      nextBillingDate: '2030-06-15',
    });
    assert.equal((await jobsOf(subscription.id)).length, 0);
  });

  it('已暂停的订阅不排提醒', async () => {
    const { subscription } = await createSub({
      status: 'paused',
      reminderEnabled: true,
      nextBillingDate: '2030-06-15',
    });
    assert.equal((await jobsOf(subscription.id)).length, 0);
  });

  it('没有下次扣费日也没有到期日时不排提醒', async () => {
    const { subscription } = await createSub({
      reminderEnabled: true,
      // 保留计费锚点（否则档案本身不合法），但两个提醒目标日期都为空
      anchorDate: '2030-06-15',
      nextBillingDate: null,
      serviceEndDate: null,
    });
    assert.equal((await jobsOf(subscription.id)).length, 0);
  });

  it('提醒时刻已经过去时不补发', async () => {
    // 扣费日已过，提前 3 天的提醒时刻自然更早
    const { subscription, reminder } = await createSub({
      reminderEnabled: true,
      reminderDaysBefore: 3,
      reminderTime: '09:00',
      anchorDate: '2020-01-15',
      nextBillingDate: '2020-01-15',
      serviceEndDate: '2020-12-31',
    });
    assert.equal(reminder.skippedPast, 1, '已过去的提醒应计入跳过');
    assert.equal((await jobsOf(subscription.id)).length, 0, '不补发');
  });
});

describe('变更后重建：旧提醒必须失效', () => {
  it('改动扣费日后旧提醒取消、新提醒按新日期建立', async () => {
    const { subscription } = await createSub({
      reminderEnabled: true,
      reminderDaysBefore: 3,
      reminderTime: '09:00',
      nextBillingDate: '2030-06-15',
    });
    const before = await jobsOf(subscription.id);
    assert.equal(before.length, 1);
    assert.equal(before[0]!.status, 'pending');

    const patched = await request(`/api/subscriptions/${subscription.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ nextBillingDate: '2030-09-15' }),
    });
    assert.equal(patched.status, 200);

    const after = await jobsOf(subscription.id);
    const pending = after.filter((j) => j.status === 'pending');
    const cancelled = after.filter((j) => j.status === 'cancelled');

    assert.equal(pending.length, 1, '应只有一条待发提醒');
    assert.equal(cancelled.length, 1, '旧提醒必须被取消');
    assert.equal(cancelled[0]!.id, before[0]!.id, '被取消的应是原来那条');
    assert.equal(pending[0]!.fireAt.toISOString(), '2030-09-12T01:00:00.000Z');
  });

  it('关闭提醒开关后未发送的提醒被取消', async () => {
    const { subscription } = await createSub({
      reminderEnabled: true,
      nextBillingDate: '2030-06-15',
    });
    assert.equal((await jobsOf(subscription.id)).filter((j) => j.status === 'pending').length, 1);

    await request(`/api/subscriptions/${subscription.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ reminderEnabled: false }),
    });

    const jobs = await jobsOf(subscription.id);
    assert.equal(jobs.filter((j) => j.status === 'pending').length, 0, '关闭提醒后不得再有待发提醒');
  });

  it('重复保存不产生重复提醒（幂等）', async () => {
    const { subscription } = await createSub({
      reminderEnabled: true,
      nextBillingDate: '2030-06-15',
    });
    for (let i = 0; i < 3; i++) {
      await request(`/api/subscriptions/${subscription.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ note: `第 ${i} 次保存` }),
      });
    }
    const jobs = await jobsOf(subscription.id);
    assert.equal(jobs.filter((j) => j.status === 'pending').length, 1, '不应因重复保存而变多');
    assert.equal(jobs.length, 1);
  });
});

describe('删除订阅清理提醒', () => {
  it('删除后不残留提醒任务与规则', async () => {
    const { subscription } = await createSub({
      reminderEnabled: true,
      nextBillingDate: '2030-06-15',
    });
    assert.equal((await jobsOf(subscription.id)).length, 1);

    const res = await request(`/api/subscriptions/${subscription.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);

    assert.equal((await jobsOf(subscription.id)).length, 0, '不得残留提醒任务');
    const rules = (await db.execute(
      sql`SELECT count(*)::int AS n FROM notification_rules WHERE subject_type = 'subscription' AND subject_id = ${subscription.id}`,
    )) as unknown as { rows: { n: number }[] };
    assert.equal(rules.rows[0]!.n, 0, '不得残留提醒规则');
    const left = await db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.id, subscription.id));
    assert.equal(left.length, 0);
  });

  it('删除订阅不会删掉已发生的付款记录', async () => {
    const { subscription } = await createSub({ reminderEnabled: false });
    await request('/api/subscriptions/payments', {
      method: 'POST',
      body: JSON.stringify({ subscriptionId: subscription.id, paidAt: '2030-01-01', amount: '20.00', currency: 'USD' }),
    });

    await request(`/api/subscriptions/${subscription.id}`, { method: 'DELETE' });

    const paid = (await db.execute(
      sql`SELECT count(*)::int AS n FROM payments`,
    )) as unknown as { rows: { n: number }[] };
    assert.equal(paid.rows[0]!.n, 1, '历史付款必须保留');
  });
});

describe('提醒字段校验', () => {
  it('提前天数超出范围被拒绝', async () => {
    const res = await request('/api/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        name: 'x',
        price: '1.00',
        billingPeriod: 'monthly',
        anchorDate: '2030-06-15',
        reminderDaysBefore: 999,
      }),
    });
    assert.equal(res.status, 400);
    assert.match((await json<{ message: string }>(res)).message, /提前天数/);
  });

  it('提醒时刻格式非法被拒绝', async () => {
    const res = await request('/api/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        name: 'x',
        price: '1.00',
        billingPeriod: 'monthly',
        anchorDate: '2030-06-15',
        reminderTime: '九点',
      }),
    });
    assert.equal(res.status, 400);
  });
});

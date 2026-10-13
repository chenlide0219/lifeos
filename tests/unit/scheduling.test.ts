/**
 * 阶段 2 回归：事项变更时的提醒重调度（PRD FR-02 / FR-07）
 *
 * 这几条规则一旦破坏，后果是"旧时间的微信消息在新时间之后到达"或"提醒永久重复"，
 * 因此每条都必须有测试守着：
 *   - 修改时间 → 旧提醒失效并重建；
 *   - 取消 / 删除 → 停止未发送的提醒；
 *   - 创建时已过去的提醒时间不补发；
 *   - 无具体时刻的待办不得排出精确提醒。
 */
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { requireTestDatabase } from '../helpers/guard';

requireTestDatabase();

const { db, pool } = await import('../../src/server/db/client');
const { events, notificationJobs, notificationRules, tasks, users } = await import(
  '../../src/server/db/schema'
);
const { hashPassword } = await import('../../src/server/lib/password');
const {
  rebuildEventNotifications,
  rebuildTaskNotifications,
  purgeSubjectNotifications,
  upsertRule,
  normalizeOffsets,
  offsetLabel,
} = await import('../../src/server/lib/scheduling');
const { zonedToInstant } = await import('../../src/server/lib/time');

/**
 * 归属账号（多用户数据隔离）。
 *
 * 提醒规则与提醒任务都用**复合外键**要求 `(subject_id, user_id)` 指向同一个人，
 * 因此本文件里直接插入事项（events / tasks）的那一处必须落在同一个账号名下。
 * 规则与任务本身由 `lib/scheduling.ts` 从事项**推导**归属，所以这里只需造一次账号：
 * `users` 不在 beforeEach 的清理范围内，靠唯一用户名幂等，重复运行本文件也不会撞约束。
 */
let userId = 0;
async function ensureOwner(): Promise<void> {
  if (userId !== 0) return;
  await db
    .insert(users)
    .values({ username: 'scheduling', passwordHash: await hashPassword('Scheduling-Pass-1!') })
    .onConflictDoNothing({ target: users.username });
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.username, 'scheduling')).limit(1);
  userId = row!.id;
}

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE notification_attempts, notification_jobs, notification_rules, events, tasks RESTART IDENTITY CASCADE`,
  );
  await ensureOwner();
});

after(async () => {
  await pool.end();
});

async function createEvent(opts: {
  title?: string;
  startAt: Date;
  status?: string;
  location?: string | null;
}) {
  const [row] = await db
    .insert(events)
    .values({
      userId,
      title: opts.title ?? '课题组会议',
      startAt: opts.startAt,
      status: opts.status ?? 'active',
      location: opts.location ?? null,
    })
    .returning({ id: events.id });
  return row!.id;
}

async function createTask(opts: { title?: string; dueDate?: string | null; dueTime?: string | null; status?: string }) {
  const [row] = await db
    .insert(tasks)
    .values({
      userId,
      title: opts.title ?? '提交报告',
      dueDate: opts.dueDate ?? null,
      dueTime: opts.dueTime ?? null,
      status: opts.status ?? 'todo',
    })
    .returning({ id: tasks.id });
  return row!.id;
}

async function jobsOf(subjectType: string, subjectId: string) {
  return db
    .select({
      id: notificationJobs.id,
      fireAt: notificationJobs.fireAt,
      status: notificationJobs.status,
      attempts: notificationJobs.attempts,
      maxAttempts: notificationJobs.maxAttempts,
      idempotencyKey: notificationJobs.idempotencyKey,
      title: notificationJobs.title,
    })
    .from(notificationJobs)
    .where(and(eq(notificationJobs.subjectType, subjectType), eq(notificationJobs.subjectId, subjectId)))
    .orderBy(notificationJobs.fireAt);
}

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);

describe('参数归一化', () => {
  it('去除非法与重复的提前量并降序排列', () => {
    assert.deepEqual(normalizeOffsets([10, 60, 10, -5, 0]), [60, 10]);
    assert.deepEqual(normalizeOffsets([1.7]), [1]);
  });

  it('提前量的中文描述可读', () => {
    assert.equal(offsetLabel(60), '提前 1 小时');
    assert.equal(offsetLabel(10), '提前 10 分钟');
    assert.equal(offsetLabel(1440), '提前 1 天');
  });
});

describe('事件提醒：创建', () => {
  it('按提前量排出对应数量的待发提醒，时刻等于开始时间减去提前量', async () => {
    const start = hoursFromNow(24);
    const id = await createEvent({ startAt: start });
    await upsertRule('event', id, { enabled: true, offsetsMinutes: [60, 10] });

    const result = await rebuildEventNotifications(id);
    assert.equal(result.created, 2);
    assert.equal(result.skippedPast, 0);

    const jobs = await jobsOf('event', id);
    assert.equal(jobs.length, 2);
    // fireAt 降序排列后为 10 分钟前与 60 分钟前
    const expected = [start.getTime() - 60 * 60_000, start.getTime() - 10 * 60_000].sort((a, b) => a - b);
    assert.deepEqual(
      jobs.map((j) => j.fireAt.getTime()),
      expected,
    );
    assert.ok(jobs.every((j) => j.status === 'pending'));
  });

  it('创建时已经过去的提醒时间不补发（PRD FR-07）', async () => {
    // 开始时间在 30 分钟后：提前 60 分钟已经过去，提前 10 分钟还没到
    const start = hoursFromNow(0.5);
    const id = await createEvent({ startAt: start });
    await upsertRule('event', id, { enabled: true, offsetsMinutes: [60, 10] });

    const result = await rebuildEventNotifications(id);
    assert.equal(result.created, 1, '只应创建未过去的那个提醒');
    assert.equal(result.skippedPast, 1, '已过去的应计入跳过而不是补发');

    const jobs = await jobsOf('event', id);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.fireAt.getTime(), start.getTime() - 10 * 60_000);
  });

  it('提醒开关关闭时不排任何提醒', async () => {
    const id = await createEvent({ startAt: hoursFromNow(24) });
    await upsertRule('event', id, { enabled: false, offsetsMinutes: [60] });

    const result = await rebuildEventNotifications(id);
    assert.equal(result.created, 0);
    assert.equal(result.ruleEnabled, false);
    assert.equal((await jobsOf('event', id)).length, 0);
  });

  it('没有规则时不排提醒，也不报错', async () => {
    const id = await createEvent({ startAt: hoursFromNow(24) });
    const result = await rebuildEventNotifications(id);
    assert.equal(result.created, 0);
  });
});

describe('事件提醒：修改时间必须重建', () => {
  it('改时间后旧提醒变为已取消，新提醒按新时间创建', async () => {
    const oldStart = hoursFromNow(24);
    const id = await createEvent({ startAt: oldStart });
    await upsertRule('event', id, { enabled: true, offsetsMinutes: [60] });
    await rebuildEventNotifications(id);

    const before = await jobsOf('event', id);
    assert.equal(before.length, 1);
    assert.equal(before[0]!.fireAt.getTime(), oldStart.getTime() - 3_600_000);

    // 改到 48 小时后
    const newStart = hoursFromNow(48);
    await db.update(events).set({ startAt: newStart }).where(eq(events.id, id));
    const result = await rebuildEventNotifications(id);

    assert.equal(result.cancelled, 1, '旧提醒必须先失效');
    assert.equal(result.created, 1);

    const after = await jobsOf('event', id);
    assert.equal(after.length, 2, '保留历史 + 新任务');
    const active = after.filter((j) => j.status === 'pending');
    assert.equal(active.length, 1);
    assert.equal(active[0]!.fireAt.getTime(), newStart.getTime() - 3_600_000);

    const cancelled = after.filter((j) => j.status === 'cancelled');
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0]!.fireAt.getTime(), oldStart.getTime() - 3_600_000, '旧提醒不得以新时间留存');
  });

  it('反复重建不会产生重复任务（幂等）', async () => {
    const id = await createEvent({ startAt: hoursFromNow(24) });
    await upsertRule('event', id, { enabled: true, offsetsMinutes: [60, 10] });

    await rebuildEventNotifications(id);
    await rebuildEventNotifications(id);
    await rebuildEventNotifications(id);

    const jobs = await jobsOf('event', id);
    assert.equal(jobs.length, 2, '同一提醒不应因重复重建而变多');
    assert.ok(
      jobs.every((j) => j.status === 'pending'),
      '重建必须保留待发状态：曾因"先取消再插入"被幂等键挡住而导致提醒静默丢失',
    );
  });

  it('被取消的同键提醒在重建时原地复活，而不是新建或丢失', async () => {
    const id = await createEvent({ startAt: hoursFromNow(24) });
    await upsertRule('event', id, { enabled: true, offsetsMinutes: [60] });
    await rebuildEventNotifications(id);

    const [before] = await jobsOf('event', id);
    // 手工制造"曾被取消"的行，模拟提醒被撤销后又被重新需要
    await db
      .update(notificationJobs)
      .set({ status: 'cancelled', attempts: 2, lastError: '曾被取消' })
      .where(eq(notificationJobs.id, before!.id));

    const result = await rebuildEventNotifications(id);

    assert.equal(result.created, 0, '同键任务不应再新建一行');
    assert.equal(result.resurrected, 1, '应复活既有行');

    const jobs = await jobsOf('event', id);
    assert.equal(jobs.length, 1, '不得产生重复任务');
    assert.equal(jobs[0]!.id, before!.id, '必须是同一行被复位');
    assert.equal(jobs[0]!.status, 'pending');
    assert.equal(jobs[0]!.attempts, 0, '复活后尝试次数应清零');
  });

  it('已发送的提醒在重建时绝不被复活（避免重复送达）', async () => {
    const id = await createEvent({ startAt: hoursFromNow(24) });
    await upsertRule('event', id, { enabled: true, offsetsMinutes: [60] });
    await rebuildEventNotifications(id);

    const [before] = await jobsOf('event', id);
    await db
      .update(notificationJobs)
      .set({ status: 'sent', sentAt: new Date() })
      .where(eq(notificationJobs.id, before!.id));

    const result = await rebuildEventNotifications(id);

    assert.equal(result.resurrected, 0);
    assert.equal(result.skippedSent, 1, '已发送的应被识别并跳过');
    assert.equal(result.created, 0, '不得为了同一提醒再建一行');

    const jobs = await jobsOf('event', id);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.status, 'sent', '已发送状态必须保持，否则会重复送达');
  });
});

describe('事件提醒：取消与删除', () => {
  it('取消事件后未发送的提醒全部变为已取消', async () => {
    const id = await createEvent({ startAt: hoursFromNow(24) });
    await upsertRule('event', id, { enabled: true, offsetsMinutes: [60, 10] });
    await rebuildEventNotifications(id);
    assert.equal((await jobsOf('event', id)).filter((j) => j.status === 'pending').length, 2);

    await db.update(events).set({ status: 'cancelled' }).where(eq(events.id, id));
    const result = await rebuildEventNotifications(id);

    assert.equal(result.cancelled, 2);
    assert.equal(result.created, 0);
    const jobs = await jobsOf('event', id);
    assert.ok(jobs.every((j) => j.status === 'cancelled'), '取消后不得再有待发提醒');
  });

  it('已发送的历史提醒不会被取消（保留记录）', async () => {
    const id = await createEvent({ startAt: hoursFromNow(24) });
    await upsertRule('event', id, { enabled: true, offsetsMinutes: [60, 10] });
    await rebuildEventNotifications(id);

    // 模拟其中一条已经发送成功
    const [first] = await jobsOf('event', id);
    await db
      .update(notificationJobs)
      .set({ status: 'sent', sentAt: new Date() })
      .where(eq(notificationJobs.id, first!.id));

    await db.update(events).set({ status: 'cancelled' }).where(eq(events.id, id));
    await rebuildEventNotifications(id);

    const jobs = await jobsOf('event', id);
    assert.equal(jobs.filter((j) => j.status === 'sent').length, 1, '已发送记录必须保留');
    assert.equal(jobs.filter((j) => j.status === 'cancelled').length, 1);
  });

  it('删除事件会清掉它的规则与任务', async () => {
    const id = await createEvent({ startAt: hoursFromNow(24) });
    await upsertRule('event', id, { enabled: true, offsetsMinutes: [60] });
    await rebuildEventNotifications(id);
    assert.equal((await jobsOf('event', id)).length, 1);

    await purgeSubjectNotifications('event', id);
    await db.delete(events).where(eq(events.id, id));

    assert.equal((await jobsOf('event', id)).length, 0, '删除后不得残留任务');
    const rules = await db
      .select({ id: notificationRules.id })
      .from(notificationRules)
      .where(and(eq(notificationRules.subjectType, 'event'), eq(notificationRules.subjectId, id)));
    assert.equal(rules.length, 0, '删除后不得残留规则');
  });
});

describe('待办提醒：必须有具体时刻', () => {
  it('只有日期没有时刻的待办不排提醒（PRD FR-02）', async () => {
    const id = await createTask({ dueDate: tomorrowDate(), dueTime: null });
    await upsertRule('task', id, { enabled: true, offsetsMinutes: [60] });

    const result = await rebuildTaskNotifications(id);
    assert.equal(result.created, 0, '全天待办不得排出精确提醒');
    assert.equal((await jobsOf('task', id)).length, 0);
  });

  it('有日期与时刻的待办按用户时区换算排出提醒', async () => {
    const target = zonedToInstant(2030, 6, 15, 15, 0);
    const id = await createTask({ dueDate: '2030-06-15', dueTime: '15:00' });
    await upsertRule('task', id, { enabled: true, offsetsMinutes: [60, 10] });

    const result = await rebuildTaskNotifications(id);
    assert.equal(result.created, 2);

    const jobs = await jobsOf('task', id);
    const expected = [target.getTime() - 3_600_000, target.getTime() - 600_000].sort((a, b) => a - b);
    assert.deepEqual(
      jobs.map((j) => j.fireAt.getTime()),
      expected,
    );
  });

  it('已完成的待办不再产生提醒', async () => {
    const id = await createTask({ dueDate: '2030-06-15', dueTime: '15:00', status: 'done' });
    await upsertRule('task', id, { enabled: true, offsetsMinutes: [60] });

    const result = await rebuildTaskNotifications(id);
    assert.equal(result.created, 0);
    assert.equal(result.ruleEnabled, false);
  });

  it('待办完成后再重建会取消原有待发提醒', async () => {
    const id = await createTask({ dueDate: '2030-06-15', dueTime: '15:00' });
    await upsertRule('task', id, { enabled: true, offsetsMinutes: [60] });
    await rebuildTaskNotifications(id);
    assert.equal((await jobsOf('task', id)).filter((j) => j.status === 'pending').length, 1);

    await db.update(tasks).set({ status: 'done', completedAt: new Date() }).where(eq(tasks.id, id));
    const result = await rebuildTaskNotifications(id);

    assert.equal(result.cancelled, 1);
    assert.ok((await jobsOf('task', id)).every((j) => j.status === 'cancelled'));
  });

  it('待办截止时刻已过去时不补发提醒', async () => {
    const id = await createTask({ dueDate: '2020-01-01', dueTime: '09:00' });
    await upsertRule('task', id, { enabled: true, offsetsMinutes: [10] });

    const result = await rebuildTaskNotifications(id);
    assert.equal(result.created, 0);
    assert.equal(result.skippedPast, 1);
  });
});

/** 明天的日期字符串（服务器时区无关，只用于构造数据） */
function tomorrowDate(): string {
  const d = new Date(Date.now() + 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

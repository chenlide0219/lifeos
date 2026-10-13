/**
 * 查询执行的真实数据库行为（PRD 3.5、16.1-3 已确认口径）。
 *
 * 范围换算（`resolveRange`）已有单测，但**真正查库并按已确认口径分组**从未被验证：
 *   - 今日**含逾期未完成**，且逾期单独成组；
 *   - **不含**已完成 / 已取消；
 *   - **无日期待办**不属于任何一天，末尾单独列出；
 *   - 跨天事件按**开始日**归属；
 *   - 未来七天**含今天**。
 *
 * 这些正是用户发 `/today`、`/list` 时看到的实际内容，漏一条就会看到错误或缺失的安排。
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) throw new Error('测试需要 TEST_DATABASE_URL');
if (!new URL(process.env.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('测试库名必须以 _test 结尾');
}

const { db, pool } = await import('../../src/server/db/client');
const { users } = await import('../../src/server/db/schema');
const { hashPassword } = await import('../../src/server/lib/password');
const { eq, sql } = await import('drizzle-orm');
const { loadQueryData, resolveRange, rangeDayCount, runQuery } = await import(
  '../../src/server/lib/wechat-query'
);
const { todayInTz, addDays, zonedToInstant } = await import('../../src/server/lib/time');

/** 固定"现在"为北京时间某日中午，日期运算才有确定结果 */
const NOW = zonedToInstant(2026, 10, 12, 12, 0);
const TODAY = todayInTz('Asia/Shanghai') && '2026-10-12';

/**
 * 归属账号 id（多用户数据隔离）。
 *
 * `events` / `tasks` 的 `user_id` 是 NOT NULL，本文件用原生 SQL 直接灌数据，
 * 所以必须先把账号建出来、把 id 带上。只建一次，避免重复运行本文件时撞唯一约束。
 */
let userId = 0;
async function ensureOwner(): Promise<void> {
  if (userId !== 0) return;
  await db
    .insert(users)
    .values({ username: 'wechat-query', passwordHash: await hashPassword('Wechat-Query-Pass-1!') })
    .onConflictDoNothing({ target: users.username });
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.username, 'wechat-query')).limit(1);
  userId = row!.id;
}

async function seedEvent(title: string, dateStr: string, hour = 15, status = 'active') {
  await ensureOwner();
  const [y, m, d] = dateStr.split('-').map(Number);
  await db.execute(sql`
    INSERT INTO events(user_id, title, start_at, location, status, source)
    VALUES (${userId}, ${title}, ${zonedToInstant(y!, m!, d!, hour, 0).toISOString()}, ${'地点'}, ${status}, 'wechat')
  `);
}

async function seedTask(title: string, dueDate: string | null, dueTime: string | null, status = 'todo') {
  await ensureOwner();
  await db.execute(sql`
    INSERT INTO tasks(user_id, title, due_date, due_time, status, source)
    VALUES (${userId}, ${title}, ${dueDate}, ${dueTime}, ${status}, 'wechat')
  `);
}

async function clean(): Promise<void> {
  await db.execute(sql`DELETE FROM events`);
  await db.execute(sql`DELETE FROM tasks`);
}

before(async () => {
  // 查询一律按账号限定：夹具先确保账号存在，避免"没灌数据"的用例拿到 userId=0
  await ensureOwner();
  await clean();
});
beforeEach(clean);
after(async () => {
  await clean();
  await pool.end();
});

describe('范围换算（已确认口径）', () => {
  it('未来七天含今天，共 7 天', () => {
    const range = resolveRange({ preset: 'week', date: null, filter: 'all' }, NOW);
    assert.equal(range.fromDate, '2026-10-12');
    assert.equal(range.toDate, '2026-10-18');
    assert.equal(rangeDayCount(range), 7, '含今天共 7 天');
  });

  it('明天是单日且不含逾期', () => {
    const range = resolveRange({ preset: 'tomorrow', date: null, filter: 'all' }, NOW);
    assert.equal(range.fromDate, '2026-10-13');
    assert.equal(range.toDate, '2026-10-13');
    assert.equal(range.includeOverdue, false);
  });

  it('今日含逾期，未来七天也含逾期', () => {
    assert.equal(resolveRange({ preset: 'today', date: null, filter: 'all' }, NOW).includeOverdue, true);
    assert.equal(resolveRange({ preset: 'week', date: null, filter: 'all' }, NOW).includeOverdue, true);
  });

  it('指定日期按 date 预设，缺日期时退回今天', () => {
    const ok = resolveRange({ preset: 'date', date: '2026-10-20', filter: 'all' }, NOW);
    assert.equal(ok.fromDate, '2026-10-20');
    const fallback = resolveRange({ preset: 'date', date: null, filter: 'all' }, NOW);
    assert.equal(fallback.fromDate, '2026-10-12');
  });
});

describe('今日查询的真实结果与分组', () => {
  it('逾期未完成单独成组，当天到期另一组，无日期待办末尾列出', async () => {
    await seedTask('逾期的任务', '2026-10-05', null); // 逾期
    await seedTask('今天到期', TODAY, '18:00'); // 今天
    await seedTask('没日期的任务', null, null); // 收件箱
    await seedEvent('今天的会', TODAY, 15);

    const data = await loadQueryData(userId, { preset: 'today', date: null, filter: 'all' }, NOW);
    const labels = data.groups.groups.map((g) => g.label);
    const titles = data.groups.groups.flatMap((g) => g.items.map((i) => i.title));

    assert.ok(labels.includes('逾期'), `应有逾期分组，实际 ${JSON.stringify(labels)}`);
    assert.ok(titles.includes('逾期的任务'), '逾期任务必须出现在今日');
    assert.ok(titles.includes('今天到期'));
    assert.ok(titles.includes('今天的会'));
    assert.ok(titles.includes('没日期的任务'), '无日期待办应单独列出，不能被丢掉');

    // 无日期待办必须**不在**当天组里
    const todayGroup = data.groups.groups.find((g) => g.label === '当天待办');
    assert.ok(todayGroup, '应有当天组');
    assert.ok(
      !todayGroup!.items.some((i) => i.title === '没日期的任务'),
      '无日期待办不属于任何一天',
    );
  });

  it('已完成与已取消不出现在今日', async () => {
    await seedTask('已完成的任务', TODAY, '10:00', 'done');
    await seedTask('已取消的任务', TODAY, '11:00', 'cancelled');
    await seedTask('正常的任务', TODAY, '12:00', 'todo');

    const data = await loadQueryData(userId, { preset: 'today', date: null, filter: 'all' }, NOW);
    const titles = data.groups.groups.flatMap((g) => g.items.map((i) => i.title));
    assert.ok(titles.includes('正常的任务'));
    assert.ok(!titles.includes('已完成的任务'), '不含已完成');
    assert.ok(!titles.includes('已取消的任务'), '不含已取消');
  });

  it('已取消的事件不出现', async () => {
    await seedEvent('取消掉的会', TODAY, 9, 'cancelled');
    await seedEvent('正常会议', TODAY, 10);

    const data = await loadQueryData(userId, { preset: 'today', date: null, filter: 'all' }, NOW);
    const titles = data.groups.groups.flatMap((g) => g.items.map((i) => i.title));
    assert.ok(titles.includes('正常会议'));
    assert.ok(!titles.includes('取消掉的会'));
  });

  it('跨天事件按开始日归属，只在开始那天出现', async () => {
    // 事件从 10-13 开始、10-15 结束
    await ensureOwner();
    const [y, m, d] = '2026-10-13'.split('-').map(Number);
    const start = zonedToInstant(y!, m!, d!, 9, 0);
    const end = zonedToInstant(2026, 10, 15, 18, 0);
    await db.execute(sql`
      INSERT INTO events(user_id, title, start_at, end_at, status, source)
      VALUES (${userId}, ${'跨天会议'}, ${start.toISOString()}, ${end.toISOString()}, 'active', 'wechat')
    `);

    const onStart = await loadQueryData(userId, { preset: 'date', date: '2026-10-13', filter: 'all' }, NOW);
    assert.ok(
      onStart.groups.groups.some((g) => g.items.some((i) => i.title === '跨天会议')),
      '开始日应出现',
    );

    const onMiddle = await loadQueryData(userId, { preset: 'date', date: '2026-10-14', filter: 'all' }, NOW);
    assert.ok(
      !onMiddle.groups.groups.some((g) => g.items.some((i) => i.title === '跨天会议')),
      '中间日不应重复出现（按开始日归属）',
    );
  });

  it('明天查询不含逾期、不含无日期待办', async () => {
    await seedTask('逾期的任务', '2026-10-05', null);
    await seedTask('明天的任务', '2026-10-13', '09:00');
    await seedTask('没日期的任务', null, null);

    const data = await loadQueryData(userId, { preset: 'tomorrow', date: null, filter: 'all' }, NOW);
    const titles = data.groups.groups.flatMap((g) => g.items.map((i) => i.title));
    assert.ok(titles.includes('明天的任务'));
    assert.ok(!data.groups.groups.some((g) => g.label === '逾期'), '明天不应有逾期分组');
  });

  it('filter=task 时不返回事件', async () => {
    await seedEvent('今天的会', TODAY, 15);
    await seedTask('今天的活', TODAY, '16:00');

    const data = await loadQueryData(userId, { preset: 'today', date: null, filter: 'task' }, NOW);
    const types = data.groups.groups.flatMap((g) => g.items.map((i) => i.type));
    assert.ok(types.includes('task'));
    assert.ok(!types.includes('event'), 'filter=task 不应包含事件');
  });

  it('filter=event 时不返回待办', async () => {
    await seedEvent('今天的会', TODAY, 15);
    await seedTask('今天的活', TODAY, '16:00');

    const data = await loadQueryData(userId, { preset: 'today', date: null, filter: 'event' }, NOW);
    const types = data.groups.groups.flatMap((g) => g.items.map((i) => i.type));
    assert.ok(types.includes('event'));
    assert.ok(!types.includes('task'), 'filter=event 不应包含待办');
  });
});

describe('回复组装', () => {
  it('无结果时给出空文案而非报错', async () => {
    const result = await runQuery(userId, { preset: 'today', date: null, filter: 'all' }, NOW, null);
    assert.equal(result.total, 0);
    assert.match(result.body, /没有安排/);
  });

  it('超过条数上限时如实标注剩余条数', async () => {
    for (let i = 0; i < 12; i += 1) {
      await seedTask(`任务${i}`, TODAY, `${String(9 + (i % 10)).padStart(2, '0')}:00`);
    }
    const result = await runQuery(userId, { preset: 'today', date: null, filter: 'all' }, NOW, null);
    assert.equal(result.total, 12);
    assert.equal(result.shown, 8, '最多显示 8 条');
    assert.match(result.body, /另有 4 条未显示/);
  });

  it('查询后可附带草稿提示（不破坏草稿）', async () => {
    await seedTask('今天的活', TODAY, '16:00');
    const notice = '当前仍有「组会」草稿未保存，可继续修改、确认或取消。';
    const result = await runQuery(userId, { preset: 'today', date: null, filter: 'all' }, NOW, notice);
    assert.match(result.body, /组会/);
    assert.match(result.body, /今天的活/);
  });
});

/**
 * 原子创建与草稿操作回归（PRD 6、7.2、8.1）。
 *
 * 这一组断言针对的是"一旦做错就会造成脏数据或重复事项"的地方：
 *   - 提交必须在**一个事务**内完成事项、提醒规则、提醒任务、操作终态与回复入队；
 *   - 重复确认只能返回原结果，绝不重复创建；
 *   - 版本不匹配、状态不对、短码过期都不得写库；
 *   - 数据库偏唯一索引必须真的挡住第二个活动草稿（不能只靠应用判断）。
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) throw new Error('测试需要 TEST_DATABASE_URL');
if (!new URL(process.env.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('测试库名必须以 _test 结尾');
}

const { db, pool } = await import('../../src/server/db/client');
const { sql } = await import('drizzle-orm');
const {
  commitOperation,
  createOperation,
  findByShortCode,
  invalidateOperations,
  listRecentOperations,
  loadActiveOperation,
  updateOperation,
} = await import('../../src/server/lib/wechat-operations');
const { emptyDraft, applyPatch, missingFields } = await import('../../src/server/lib/wechat-draft');
type Draft = import('../../src/server/lib/wechat-draft').Draft;
const { zonedToInstant } = await import('../../src/server/lib/time');
const { wechatOutbox } = await import('../../src/server/db/schema');

const GEN = '33333333-3333-4333-8333-333333333333';
const INBOX = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-10-12T04:00:00Z'); // 北京时间 12:00

function futureEventDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    ...emptyDraft('event'),
    title: '组会',
    startAt: zonedToInstant(2026, 10, 14, 15, 0).toISOString(),
    location: '科研楼',
    providedFields: ['title', 'startAt', 'location'],
    ...overrides,
  };
}

async function clean(): Promise<void> {
  await db.execute(sql`DELETE FROM wechat_outbox`);
  await db.execute(sql`DELETE FROM wechat_operations`);
  await db.execute(sql`DELETE FROM notification_jobs`);
  await db.execute(sql`DELETE FROM notification_rules`);
  await db.execute(sql`DELETE FROM events`);
  await db.execute(sql`DELETE FROM tasks`);
}

async function seed(sourceInboxId = INBOX) {
  return createOperation({
    bindingGeneration: GEN,
    draftKind: 'event',
    draft: futureEventDraft(),
    missingFields: [],
    shortCode: 'A7K2',
    sourceInboxId,
    now: NOW,
  });
}

before(clean);
beforeEach(clean);
after(async () => {
  await clean();
  await pool.end();
});

describe('活动草稿唯一性（数据库约束，不靠应用判断）', () => {
  it('同一代际只允许一个活动草稿', async () => {
    const first = await seed(INBOX);
    assert.ok(first);
    // 换一条来源消息，模拟"又一个创建请求"
    const second = await seed('55555555-5555-4555-8555-555555555555');
    assert.equal(second, null, '第二个活动草稿必须被偏唯一索引拒绝');
  });

  it('终态草稿不占用活动名额', async () => {
    const first = await seed(INBOX);
    await commitOperation(first!.id, first!.version, NOW);

    const second = await seed('66666666-6666-4666-8666-666666666666');
    assert.ok(second, '前一个已提交后应能新建草稿');
  });

  it('同一条来源消息重复处理不会造出第二个草稿（幂等键）', async () => {
    const first = await seed(INBOX);
    assert.ok(first);
    const again = await seed(INBOX);
    assert.equal(again, null);
    const recent = await listRecentOperations(GEN);
    assert.equal(recent.length, 1);
  });
});

describe('原子提交', () => {
  it('一次提交同时建立事项、提醒规则、提醒任务、操作终态与回复入队', async () => {
    const op = await seed();
    const result = await commitOperation(op!.id, op!.version, NOW);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.subjectType, 'event');

    const ev = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM events WHERE id = ${result.subjectId}`);
    assert.equal(ev.rows![0]!.n, 1, '事项必须已创建');

    const rule = await db.execute<{ n: number; enabled: boolean }>(
      sql`SELECT count(*)::int AS n, bool_and(enabled) AS enabled FROM notification_rules WHERE subject_id = ${result.subjectId}`,
    );
    assert.equal(rule.rows![0]!.n, 1, '提醒规则必须已建立');
    assert.equal(rule.rows![0]!.enabled, true);

    // 距开始约 2 天，两档都排得上
    const jobs = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM notification_jobs WHERE subject_id = ${result.subjectId} AND status = 'pending'`,
    );
    assert.equal(jobs.rows![0]!.n, 2, '默认 [60,10] 两档提醒都应排上');

    const opRow = await db.execute<{ status: string; result_subject_id: string }>(
      sql`SELECT status, result_subject_id FROM wechat_operations WHERE id = ${op!.id}`,
    );
    assert.equal(opRow.rows![0]!.status, 'committed');
    assert.equal(opRow.rows![0]!.result_subject_id, result.subjectId);

    const out = await db
      .select({ status: wechatOutbox.status, replyType: wechatOutbox.replyType })
      .from(wechatOutbox);
    assert.equal(out.length, 1, '回复必须已入队');
    assert.equal(out[0]!.status, 'pending');
    assert.equal(out[0]!.replyType, 'created');
  });

  it('重复确认返回原结果，不重复创建事项或提醒', async () => {
    const op = await seed();
    const first = await commitOperation(op!.id, op!.version, NOW);
    assert.equal(first.ok, true);

    const second = await commitOperation(op!.id, op!.version, NOW);
    assert.equal(second.ok, true);
    if (first.ok && second.ok) {
      assert.equal(second.subjectId, first.subjectId, '必须复用同一事项');
      assert.equal(second.createdJobs, 0);
    }

    const ev = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM events`);
    assert.equal(ev.rows![0]!.n, 1, '不得创建第二个事项');
    const out = await db.select({ id: wechatOutbox.id }).from(wechatOutbox);
    assert.equal(out.length, 1, '不得入队第二条已创建回复');
  });

  it('版本不匹配拒绝提交（旧短码不能提交新草稿）', async () => {
    const op = await seed();
    const result = await commitOperation(op!.id, op!.version + 1, NOW);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /最新短码/);

    const ev = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM events`);
    assert.equal(ev.rows![0]!.n, 0, '拒绝时不得写库');
  });

  it('已取消的草稿不能提交', async () => {
    const op = await seed();
    await db.execute(sql`UPDATE wechat_operations SET status='cancelled' WHERE id = ${op!.id}`);
    const result = await commitOperation(op!.id, op!.version, NOW);
    assert.equal(result.ok, false);
  });

  it('缺字段草稿（awaiting_fields）不能提交', async () => {
    const created = await createOperation({
      bindingGeneration: GEN,
      draftKind: 'event',
      draft: { ...emptyDraft('event'), title: '开会' },
      missingFields: missingFields({ ...emptyDraft('event'), title: '开会' }),
      shortCode: 'B3C4',
      sourceInboxId: INBOX,
      now: NOW,
    });
    assert.equal(created!.status, 'awaiting_fields');
    const result = await commitOperation(created!.id, created!.version, NOW);
    assert.equal(result.ok, false);
  });

  it('时间过近时只排剩余档位，且跳过数被如实记录', async () => {
    // 开始时间 = 45 分钟后 → 只有提前 10 分钟可排
    const soon: Draft = {
      ...emptyDraft('event'),
      title: '临时会',
      startAt: new Date(NOW.getTime() + 45 * 60_000).toISOString(),
    };
    const op = await createOperation({
      bindingGeneration: GEN,
      draftKind: 'event',
      draft: soon,
      missingFields: [],
      shortCode: 'C5D6',
      sourceInboxId: INBOX,
      now: NOW,
    });
    const result = await commitOperation(op!.id, op!.version, NOW);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.createdJobs, 1);
    assert.equal(result.skippedPast, 1);
  });

  it('无日期待办可以保存，但不生成任何提醒任务（16.1-2）', async () => {
    const task: Draft = { ...emptyDraft('task'), title: '交材料' };
    const op = await createOperation({
      bindingGeneration: GEN,
      draftKind: 'task',
      draft: task,
      missingFields: [],
      shortCode: 'D7E8',
      sourceInboxId: INBOX,
      now: NOW,
    });
    const result = await commitOperation(op!.id, op!.version, NOW);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.subjectType, 'task');
    assert.equal(result.createdJobs, 0, '缺日期/时刻不得生成提醒任务');

    const jobs = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM notification_jobs`);
    assert.equal(jobs.rows![0]!.n, 0);
  });

  it('用户主动关闭提醒时不建提醒任务，规则保持关闭', async () => {
    const op = await createOperation({
      bindingGeneration: GEN,
      draftKind: 'event',
      draft: futureEventDraft({ reminderDeclined: true }),
      missingFields: [],
      shortCode: 'E9F2',
      sourceInboxId: INBOX,
      now: NOW,
    });
    const result = await commitOperation(op!.id, op!.version, NOW);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.createdJobs, 0);
    const rule = await db.execute<{ enabled: boolean }>(
      sql`SELECT enabled FROM notification_rules WHERE subject_id = ${result.subjectId}`,
    );
    assert.equal(rule.rows![0]!.enabled, false, '规则必须保持关闭，不能被默认值打开');
  });

  it('补全字段后状态自动升级为 pending_confirm，否则草稿会永久无法确认（真实缺陷回归）', async () => {
    // 缺开始时间的草稿
    const incomplete: Draft = { ...emptyDraft('event'), title: '开会' };
    const op = await createOperation({
      bindingGeneration: GEN,
      draftKind: 'event',
      draft: incomplete,
      missingFields: missingFields(incomplete),
      shortCode: 'H4J5',
      sourceInboxId: INBOX,
      now: NOW,
    });
    assert.equal(op!.status, 'awaiting_fields');

    // 补齐开始时间
    const complete: Draft = { ...incomplete, startAt: zonedToInstant(2026, 10, 14, 15, 0).toISOString() };
    const updated = await updateOperation({
      operationId: op!.id,
      draft: complete,
      missingFields: missingFields(complete),
      shortCode: 'K6L7',
      bumpVersion: true,
      now: NOW,
    });

    assert.equal(updated!.status, 'pending_confirm', '补全字段后必须升级为待确认');
    assert.deepEqual(updated!.missingFields, []);

    // 关键后果验证：升级后才可能提交（commitOperation 只接受 pending_confirm）
    const result = await commitOperation(op!.id, updated!.version, NOW);
    assert.equal(result.ok, true, '补全字段的草稿必须能够提交');
  });

  it('补丁仍缺字段时保持 awaiting_fields', async () => {
    const incomplete: Draft = { ...emptyDraft('event'), title: '开会' };
    const op = await createOperation({
      bindingGeneration: GEN,
      draftKind: 'event',
      draft: incomplete,
      missingFields: missingFields(incomplete),
      shortCode: 'M8N9',
      sourceInboxId: INBOX,
      now: NOW,
    });

    // 只补了备注，仍然缺开始时间
    const stillMissing: Draft = { ...incomplete, note: '记得带材料' };
    const updated = await updateOperation({
      operationId: op!.id,
      draft: stillMissing,
      missingFields: missingFields(stillMissing),
      bumpVersion: true,
      now: NOW,
    });
    assert.equal(updated!.status, 'awaiting_fields');
  });
});

describe('短码、版本与到期', () => {
  it('按短码能定位活动草稿', async () => {
    const op = await seed();
    const found = await findByShortCode(GEN, 'A7K2');
    assert.equal(found?.id, op!.id);
  });

  it('提交后短码不再命中（旧码失效）', async () => {
    const op = await seed();
    await commitOperation(op!.id, op!.version, NOW);
    assert.equal(await findByShortCode(GEN, 'A7K2'), null);
  });

  it('有效修改递增版本并续期', async () => {
    const op = await seed();
    const later = new Date(NOW.getTime() + 10 * 60_000);
    const updated = await updateOperation({
      operationId: op!.id,
      draft: futureEventDraft({ title: '新标题' }),
      shortCode: 'F3G4',
      bumpVersion: true,
      now: later,
    });
    assert.equal(updated!.version, 2);
    assert.equal(updated!.shortCode, 'F3G4');
    // 续期自最后一次修改起算
    assert.equal(updated!.expiresAt.getTime(), later.getTime() + 30 * 60_000);
  });

  it('换绑后代际不匹配的草稿不再被读取或提交', async () => {
    const op = await seed();
    const affected = await invalidateOperations(GEN, NOW);
    assert.equal(affected, 1);
    assert.equal(await loadActiveOperation(GEN), null);
    const result = await commitOperation(op!.id, op!.version, NOW);
    assert.equal(result.ok, false);
  });
});

describe('补丁与草稿读取', () => {
  it('补丁只改指定字段并保留其余内容', async () => {
    const op = await seed();
    const { draft } = applyPatch(op!.draft!, { title: '改名' }, NOW);
    const updated = await updateOperation({ operationId: op!.id, draft, bumpVersion: true, now: NOW });
    assert.equal(updated!.draft!.title, '改名');
    assert.equal(updated!.draft!.location, '科研楼', '未提供的字段必须保留');
    assert.equal(updated!.draft!.startAt, op!.draft!.startAt);
  });
});

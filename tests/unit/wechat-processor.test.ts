/**
 * 入站处理器端到端回归（PRD 3、6、7.2）。
 *
 * 用真实数据库 + 桩化模型，跑完整链路：
 *   入库 → 领取 → 路由 → 建草稿/补丁/确认 → 原子创建 → 回复入队
 *
 * 断言的是"业务是否真的闭环"，而不是某个函数返回值：
 *   - 一句话能建出草稿并给出带短码的预览；
 *   - 补充信息能更新草稿并换短码；
 *   - 完整短码确认后库里有事项 + 提醒 + 回复；
 *   - 取消后不产生事项；
 *   - 查询读真实数据库；
 *   - 输入开关关闭时不处理业务。
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) throw new Error('测试需要 TEST_DATABASE_URL');
if (!new URL(process.env.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('测试库名必须以 _test 结尾');
}
process.env.SESSION_SECRET ??= 'test-secret-at-least-thirty-two-characters-long';
process.env.WECHAT_MODEL_CALLS = '0';

const { db, pool } = await import('../../src/server/db/client');
const { sql } = await import('drizzle-orm');
const { persistInbound } = await import('../../src/server/lib/wechat-inbox');
const { processInboxBatch, buildRecentText } = await import('../../src/server/lib/wechat-processor');
const { createOperation, loadActiveOperation, listRecentOperations } = await import(
  '../../src/server/lib/wechat-operations'
);
const { emptyDraft } = await import('../../src/server/lib/wechat-draft');
type Draft = import('../../src/server/lib/wechat-draft').Draft;
const { zonedToInstant } = await import('../../src/server/lib/time');

const GEN = '77777777-7777-4777-8777-777777777777';
const USER = 'owner@im.wechat';
const NOW = new Date('2026-10-12T04:00:00Z');

/**
 * 桩化模型：按消息内容给出确定性结果，让整条链路可离线复验。
 * 关键点是**不联网**，同时保持与真实模型相同的返回形状。
 */
const stubDeps = {
  classifyIntent: async (text: string) => {
    if (/取消明天|删掉|改成/.test(text) && /会议|明天的会/.test(text)) {
      return { ok: true as const, intent: 'unsupported_operation' as const, confidence: 0.9 };
    }
    if (/今天|明天有|有什么|安排/.test(text)) {
      return { ok: true as const, intent: 'query' as const, confidence: 0.9 };
    }
    // 补充/修改类表达；无草稿时 router 会按新建处理，因此这里只描述意图
    if (/^下午|^上午|^晚上|^改到|^地点|^不要提醒|三点/.test(text)) {
      return { ok: true as const, intent: 'patch_draft' as const, confidence: 0.9 };
    }
    return { ok: true as const, intent: 'create' as const, confidence: 0.9 };
  },
  extractNewDraft: async (text: string) => {
    // 与真实抽取保持同样的"缺字段"语义
    if (text.includes('开会') && !text.includes('三点')) {
      return {
        ok: true as const,
        draft: { ...emptyDraft('event'), title: '开会', providedFields: ['title'] } as Draft,
        ambiguities: ['没有识别到明确的开始时间'],
      };
    }
    return {
      ok: true as const,
      draft: {
        ...emptyDraft('event'),
        title: '组会',
        startAt: zonedToInstant(2026, 10, 14, 15, 0).toISOString(),
        location: '科研楼',
        providedFields: ['title', 'startAt', 'location'],
      } as Draft,
      ambiguities: [],
    };
  },
  extractDraftPatch: async (text: string) => {
    if (text.includes('不要提醒')) return { ok: true as const, patch: { reminder_declined: true }, ambiguous: null };
    if (text.includes('改到')) return { ok: true as const, patch: { location: '新楼' }, ambiguous: null };
    return {
      ok: true as const,
      patch: { start_at: zonedToInstant(2026, 10, 14, 15, 0).toISOString() },
      ambiguous: null,
    };
  },
  extractQuery: async () => ({
    ok: true as const,
    spec: { preset: 'today' as const, date: null, filter: 'all' as const },
  }),
};

async function clean(): Promise<void> {
  await db.execute(sql`DELETE FROM wechat_outbox`);
  await db.execute(sql`DELETE FROM wechat_operations`);
  await db.execute(sql`DELETE FROM wechat_inbox`);
  await db.execute(sql`DELETE FROM notification_jobs`);
  await db.execute(sql`DELETE FROM notification_rules`);
  await db.execute(sql`DELETE FROM events`);
  await db.execute(sql`DELETE FROM tasks`);
}

/** 直接灌入一条入站消息（绕过网络轮询） */
async function feed(text: string, providerMessageId: string, receivedAt = NOW) {
  await persistInbound({
    generation: GEN,
    messages: [
      {
        providerMessageId,
        fromUserId: USER,
        messageType: 1,
        text,
        contextToken: 'ctx',
        providerTimeMs: receivedAt.getTime(),
        fingerprint: providerMessageId,
      },
    ],
    receivedAt,
    cursor: `cursor-${providerMessageId}`,
    context: { token: 'ctx', at: receivedAt, providerTimeMs: receivedAt.getTime() },
    boundUserId: USER,
  });
}

/**
 * 建立"已绑定且代际为 GEN"的私有状态。
 *
 * 这是**必须**的一步：`persistInbound` 会校验绑定代际，
 * 代际不符时拒绝入库（防止换绑后旧消息落库）。少了它，
 * 消息会在入库阶段被静默拒绝，表现为"处理器什么都不做"。
 */
async function installBoundState(): Promise<void> {
  const state = {
    generation: GEN,
    account: 'sealed-placeholder',
    context: null,
    cursor: '',
    revision: 'revision-1',
    seen: [],
    used: 0,
    accepted: 0,
    failed: 0,
    unknown: 0,
    warned: false,
    warningResult: null,
    pausedReason: null,
    boundAt: NOW.getTime(),
    refreshedAt: null,
    lastInboundTime: 0,
    listenerAt: null,
    listenerError: null,
  };
  await db.execute(sql`
    INSERT INTO settings(key, value)
    VALUES ('wechat.private-channel', ${JSON.stringify(state)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `);
}

async function runBatch(now = NOW) {
  return processInboxBatch(10, { deps: stubDeps, inboundEnabled: true, now });
}

async function outboxRows() {
  const rows = await db.execute<{ reply_type: string; body: string; status: string; operation_id: string | null }>(
    sql`SELECT reply_type, body, status, operation_id FROM wechat_outbox ORDER BY created_at`,
  );
  return rows.rows ?? [];
}

before(clean);
beforeEach(async () => {
  await clean();
  await installBoundState();
});
after(async () => {
  await clean();
  // 必须清掉私有渠道状态：本文件写入的是"已扫码绑定"状态，而 notification provider
  // 一旦看到 account 就会走扫码发送路径（缺 context 时推迟发送），
  // 会让 worker.test.ts 中依赖旧式 ILINK_TOKEN 通道的用例全部失败。
  // 这与 wechat-inbox.test.ts / wechat-binding.test.ts 的清理方式一致。
  await db.execute(sql`DELETE FROM settings WHERE key = 'wechat.private-channel'`);
  await pool.end();
});

describe('新建草稿与预览', () => {
  it('一句话建出草稿并回复带短码的预览', async () => {
    await feed('/add 明天下午三点科研楼开组会', 'm1');
    const outcomes = await runBatch();
    assert.deepEqual(outcomes.map((o) => o.result), ['done']);

    const op = await loadActiveOperation(GEN);
    assert.ok(op, '应建立活动草稿');
    assert.equal(op!.status, 'pending_confirm');
    assert.ok(op!.shortCode, '应生成短码');

    const out = await outboxRows();
    assert.equal(out.length, 1);
    assert.equal(out[0]!.reply_type, 'preview');
    assert.match(out[0]!.body, /待确认/);
    assert.match(out[0]!.body, new RegExp(op!.shortCode!));
    assert.equal(out[0]!.operation_id, op!.id);
  });

  it('缺字段时保存草稿并追问，不丢弃用户输入', async () => {
    await feed('/add 明天开会', 'm2');
    await runBatch();

    const op = await loadActiveOperation(GEN);
    assert.ok(op, '缺字段也要保存草稿');
    assert.equal(op!.status, 'awaiting_fields');
    assert.deepEqual(op!.missingFields, ['start_at']);

    const out = await outboxRows();
    assert.equal(out.length, 1);
    assert.match(out[0]!.body, /请补充开始时间/);
    assert.doesNotMatch(out[0]!.body, /待确认/, '缺字段不得给出可保存的短码预览');
  });

  it('补充信息后升级为待确认并换新短码', async () => {
    await feed('/add 明天开会', 'm3');
    await runBatch();
    const before = await loadActiveOperation(GEN);

    await feed('下午三点', 'm4');
    await runBatch();
    const after = await loadActiveOperation(GEN);

    assert.ok(after);
    assert.equal(after!.status, 'pending_confirm');
    assert.equal(after!.version, before!.version + 1, '有效修改必须递增版本');
    assert.notEqual(after!.shortCode, before!.shortCode, '必须换新短码');

    const out = await outboxRows();
    assert.equal(out.length, 2);
    assert.match(out[1]!.body, /待确认/);
  });
});

describe('确认提交与取消', () => {
  it('完整短码确认后库里同时有事项、提醒与回复', async () => {
    await feed('/add 明天下午三点科研楼开组会', 'c1');
    await runBatch();
    const op = await loadActiveOperation(GEN);

    await feed(`确认 ${op!.shortCode}`, 'c2');
    await runBatch();

    const ev = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM events`);
    assert.equal(ev.rows![0]!.n, 1, '应创建事项');

    const jobs = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM notification_jobs WHERE status='pending'`);
    assert.equal(jobs.rows![0]!.n, 2, '默认 [60,10] 两档提醒');

    const out = await outboxRows();
    assert.ok(out.some((r) => r.reply_type === 'created'), '应有已创建回复');

    assert.equal(await loadActiveOperation(GEN), null, '提交后不应再有活动草稿');
  });

  it('错误短码不提交，并提示有效短码', async () => {
    await feed('/add 明天下午三点开组会', 'c3');
    await runBatch();
    const op = await loadActiveOperation(GEN);

    await feed('确认 ZZZZ', 'c4');
    await runBatch();

    const ev = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM events`);
    assert.equal(ev.rows![0]!.n, 0, '错误短码不得写库');

    const out = await outboxRows();
    assert.match(out[out.length - 1]!.body, new RegExp(op!.shortCode!));
  });

  it('重复确认只返回原结果，不重复创建', async () => {
    await feed('/add 明天下午三点开组会', 'c5');
    await runBatch();
    const op = await loadActiveOperation(GEN);
    const code = op!.shortCode!;

    await feed(`确认 ${code}`, 'c6');
    await runBatch();
    // 草稿已结束，再次确认应得到明确提示而不是又建一条
    await feed(`确认 ${code}`, 'c7');
    await runBatch();

    const ev = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM events`);
    assert.equal(ev.rows![0]!.n, 1, '不得创建第二个事项');
  });

  it('取消后不产生事项，草稿进入终态', async () => {
    await feed('/add 明天下午三点开组会', 'x1');
    await runBatch();
    await feed('取消', 'x2');
    await runBatch();

    const ev = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM events`);
    assert.equal(ev.rows![0]!.n, 0, '取消不得写库');
    assert.equal(await loadActiveOperation(GEN), null);

    const recent = await listRecentOperations(GEN);
    assert.equal(recent[0]!.status, 'cancelled');
  });
});

describe('查询与最近操作', () => {
  it('查询读取真实数据库并包含今天到期的事项', async () => {
    // 直接写入一个今天到期的待办
    const today = '2026-10-12';
    await db.execute(
      sql`INSERT INTO tasks(title, due_date, due_time, status, source) VALUES ('交材料', ${today}, '18:00', 'todo', 'wechat')`,
    );

    await feed('/today', 'q1');
    await runBatch();

    const out = await outboxRows();
    const reply = out.find((r) => r.reply_type === 'query');
    assert.ok(reply, '应有查询回复');
    assert.match(reply!.body, /交材料/);
  });

  it('/recent 反映真实操作状态', async () => {
    await feed('/add 明天下午三点开组会', 'r1');
    await runBatch();
    await feed('取消', 'r2');
    await runBatch();

    const text = await buildRecentText(GEN);
    assert.match(text, /已取消/);
  });

  it('查询不会破坏活动草稿', async () => {
    await feed('/add 明天下午三点开组会', 'q2');
    await runBatch();
    const before = await loadActiveOperation(GEN);

    await feed('/today', 'q3');
    await runBatch();

    const after = await loadActiveOperation(GEN);
    assert.ok(after, '查询后草稿仍在');
    assert.equal(after!.id, before!.id);
    assert.equal(after!.version, before!.version, '查询不得改动草稿版本');
  });
});

describe('输入开关与终态', () => {
  it('输入开关关闭时不处理业务，但消息仍落终态', async () => {
    await feed('/add 明天下午三点开组会', 's1');
    const outcomes = await processInboxBatch(10, { deps: stubDeps, inboundEnabled: false, now: NOW });
    assert.deepEqual(outcomes.map((o) => o.result), ['skipped']);

    const ev = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM events`);
    assert.equal(ev.rows![0]!.n, 0);
    assert.equal(await loadActiveOperation(GEN), null);

    const counts = await db.execute<{ status: string; n: number }>(
      sql`SELECT status, count(*)::int AS n FROM wechat_inbox GROUP BY status`,
    );
    assert.equal(counts.rows![0]!.status, 'done', '关闭业务输入也要落终态，不能反复领取');
  });

  it('已保存事项操作被拒绝，且不顺带取消草稿', async () => {
    await createOperation({
      bindingGeneration: GEN,
      draftKind: 'event',
      draft: {
        ...emptyDraft('event'),
        title: '组会',
        startAt: zonedToInstant(2026, 10, 14, 15, 0).toISOString(),
      },
      missingFields: [],
      shortCode: 'M9N2',
      sourceInboxId: '88888888-8888-4888-8888-888888888888',
      now: NOW,
    });

    await feed('取消明天会议', 'u1');
    await runBatch();

    const op = await loadActiveOperation(GEN);
    assert.ok(op, '不得顺带取消当前草稿');
    assert.equal(op!.status, 'pending_confirm');

    const out = await outboxRows();
    assert.match(out[out.length - 1]!.body, /工作站/);
  });

  it('已有草稿时新创建请求被拒绝，不覆盖草稿', async () => {
    await feed('/add 明天下午三点开组会', 'n1');
    await runBatch();
    const before = await loadActiveOperation(GEN);

    await feed('/add 后天买牛奶', 'n2');
    await runBatch();

    const after = await loadActiveOperation(GEN);
    assert.equal(after!.id, before!.id, '不得覆盖或新建第二个草稿');
    const out = await outboxRows();
    assert.match(out[out.length - 1]!.body, /请先确认或取消/);
  });
});

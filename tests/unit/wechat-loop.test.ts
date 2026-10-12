/**
 * 创建闭环与回复投递选择（PRD 3.3、3.4、7.3）。
 *
 * 覆盖一条**真实的完整生命周期**，此前没有任何测试走过：
 *   入站消息 → 建草稿 → 预览入队 → 用户确认短码 → 原子提交
 *   → 提交后**预览必须作废**、只有「已创建」被真正发出
 *
 * 为什么必须测"投递选择"而不是"投递结果"：
 *   提交会把操作版本推高，于是那条**预览**在发送前复核时会因"版本已被替代"而作废；
 *   若这一步判断错了，用户会收到两条重复或自相矛盾的消息，
 *   或者更糟——预览被当成"已创建"发出去。
 *
 * 手法：真实数据库 + 真实草稿/提交/发送代码，只有 HTTP 与模型是桩。
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) throw new Error('测试需要 TEST_DATABASE_URL');
if (!new URL(process.env.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('测试库名必须以 _test 结尾');
}
process.env.SESSION_SECRET ??= 'test-secret-at-least-thirty-two-characters-long';

process.env.ILINK_TOKEN = 'loop-token';
process.env.ILINK_TO_USER_ID = 'loop-recipient';
process.env.ILINK_BASE_URL = 'https://ilink.loop.test';
process.env.ILINK_CONTEXT_TOKEN = 'loop-context';

const { db, pool } = await import('../../src/server/db/client');
const { sql } = await import('drizzle-orm');
const { persistInbound } = await import('../../src/server/lib/wechat-inbox');
const { processInboxBatch } = await import('../../src/server/lib/wechat-processor');
const { loadActiveOperation } = await import('../../src/server/lib/wechat-operations');
const { sendPendingReplies } = await import('../../src/worker/outbox-sender');
const { emptyDraft } = await import('../../src/server/lib/wechat-draft');
const { zonedToInstant } = await import('../../src/server/lib/time');
const { seal } = await import('../../src/server/lib/wechat-state');

const GEN = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const USER = 'loop-owner@im.wechat';
const INBOX = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const realFetch = globalThis.fetch;
let sentTexts: string[] = [];

function installFetch(): void {
  sentTexts = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('sendmessage')) {
      const body = JSON.parse(String(init?.body)) as {
        msg: { item_list: { text_item: { text: string } }[] };
      };
      sentTexts.push(body.msg.item_list[0]?.text_item.text ?? '');
      return new Response(JSON.stringify({ ret: 0, message_id: sentTexts.length }), { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}

async function installBoundState(): Promise<void> {
  const state = {
    generation: GEN,
    // 必须是**真实 seal 出来的凭据**：provider 会真的去解密。
    // 设为 null 会让 `isReplyStillValid` 正确判定"尚未绑定"并作废全部回复——
    // 看起来像发送失败，其实是夹具错了。
    account: seal({
      token: 'loop-token',
      userId: 'loop-recipient',
      botId: 'lifeos-bot',
      baseUrl: 'https://ilink.loop.test',
    }),
    context: seal('loop-context'),
    cursor: '',
    revision: 'rev-loop',
    seen: [],
    used: 0,
    accepted: 0,
    failed: 0,
    unknown: 0,
    warned: false,
    warningResult: null,
    pausedReason: null,
    boundAt: Date.now(),
    refreshedAt: Date.now(),
    lastInboundTime: 0,
    listenerAt: null,
    listenerError: null,
  };
  await db.execute(sql`
    INSERT INTO settings(key, value) VALUES ('wechat.private-channel', ${JSON.stringify(state)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `);
}

/** 桩化模型：一句话直接给出完整事件草稿 */
const stubDeps = {
  classifyIntent: async () => ({ ok: true as const, intent: 'create' as const, confidence: 0.95 }),
  extractNewDraft: async () => ({
    ok: true as const,
    draft: {
      ...emptyDraft('event'),
      title: '组会',
      startAt: zonedToInstant(2026, 10, 14, 15, 0).toISOString(),
      location: '科研楼',
      providedFields: ['title', 'startAt', 'location'],
    },
    ambiguities: [],
  }),
  extractDraftPatch: async () => ({ ok: true as const, patch: {}, ambiguous: null }),
  extractQuery: async () => ({
    ok: true as const,
    spec: { preset: 'today' as const, date: null, filter: 'all' as const },
  }),
};

async function feed(text: string, id: string) {
  await persistInbound({
    generation: GEN,
    messages: [
      {
        providerMessageId: id,
        fromUserId: USER,
        messageType: 1,
        text,
        contextToken: 'ctx',
        providerTimeMs: Date.now(),
        fingerprint: id,
      },
    ],
    receivedAt: new Date(),
    cursor: `cursor-${id}`,
    context: { token: 'ctx', at: new Date(), providerTimeMs: Date.now() },
    boundUserId: USER,
  });
}

async function runBatch() {
  return processInboxBatch(10, { deps: stubDeps, inboundEnabled: true });
}

async function outboxRows() {
  const rows = await db.execute<{ reply_type: string; status: string; failure_kind: string | null; last_error: string | null }>(
    sql`SELECT reply_type, status, failure_kind, last_error FROM wechat_outbox ORDER BY created_at`,
  );
  return rows.rows ?? [];
}

async function clean(): Promise<void> {
  await db.execute(sql`DELETE FROM wechat_outbox`);
  await db.execute(sql`DELETE FROM wechat_operations`);
  await db.execute(sql`DELETE FROM wechat_inbox`);
  await db.execute(sql`DELETE FROM notification_jobs`);
  await db.execute(sql`DELETE FROM notification_rules`);
  await db.execute(sql`DELETE FROM events`);
  await db.execute(sql`DELETE FROM settings WHERE key = 'wechat.private-channel'`);
}

before(async () => {
  await clean();
  installFetch();
});

beforeEach(async () => {
  await clean();
  installFetch();
  await installBoundState();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(async () => {
  await clean();
  await pool.end();
});

describe('创建闭环与投递选择', () => {
  it('确认后：过时的预览作废，只有「已创建」被真正发出', async () => {
    // 1) 建草稿
    await feed('/add 明天下午三点科研楼开组会', 'loop-1');
    await runBatch();
    const draft = await loadActiveOperation(GEN);
    assert.ok(draft, '应建立草稿');
    assert.ok(draft!.shortCode, '应有确认短码');

    // 2) 先发一轮：预览应被发出
    const firstSend = await sendPendingReplies(10);
    assert.equal(firstSend.sent, 1, '预览应发出');
    assert.equal(sentTexts.length, 1);
    assert.match(sentTexts[0]!, /待确认/);
    assert.match(sentTexts[0]!, new RegExp(draft!.shortCode!));

    // 3) 用户确认短码
    await feed(`确认 ${draft!.shortCode}`, 'loop-2');
    await runBatch();

    // 提交后不应再有活动草稿，且库里应有事项与提醒任务
    assert.equal(await loadActiveOperation(GEN), null, '提交后草稿结束');
    const ev = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM events`);
    assert.equal(ev.rows![0]!.n, 1, '应创建事项');
    const jobs = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM notification_jobs WHERE status='pending'`);
    assert.equal(jobs.rows![0]!.n, 2, '默认 [60,10] 两条提醒任务');

    // 4) 再发一轮：只有「已创建」应被发出
    const before = sentTexts.length;
    const secondSend = await sendPendingReplies(10);
    assert.equal(secondSend.sent, 1, '应只发出「已创建」一条');
    assert.equal(sentTexts.length, before + 1, '不应发出第二条业务消息');

    const created = sentTexts[sentTexts.length - 1]!;
    assert.match(created, /已创建/, '最后一条必须是创建成功回执');
    assert.match(created, /组会/);
    assert.match(created, /本次创建已结束/, '必须有明确的结束标志');

    // 预览那条必须已作废，而不是延迟重发
    const rows = await outboxRows();
    const preview = rows.find((r) => r.reply_type === 'preview');
    assert.equal(preview!.status, 'sent', '预览在提交前已发出');
    const createdRow = rows.find((r) => r.reply_type === 'created');
    assert.equal(createdRow!.status, 'sent');
  });

  it('预览未发出就被提交：预览必须作废，绝不迟到送达', async () => {
    await feed('/add 明天下午三点科研楼开组会', 'loop-3');
    await runBatch();
    const draft = await loadActiveOperation(GEN);

    // 关键：**不先发送预览**，直接确认短码 → 提交会把操作版本推高
    await feed(`确认 ${draft!.shortCode}`, 'loop-4');
    await runBatch();

    // 现在才发送：预览因"被新版本替代"应作废，只有「已创建」发出
    const result = await sendPendingReplies(10);
    assert.equal(result.sent, 1, '只应发出「已创建」');
    assert.equal(result.suppressed, 1, '预览应被作废');
    assert.equal(sentTexts.length, 1);
    assert.match(sentTexts[0]!, /已创建/, '唯一发出的必须是创建回执');
    assert.doesNotMatch(sentTexts[0]!, /待确认/, '绝不能把预览当成结果发出');

    const rows = await outboxRows();
    const preview = rows.find((r) => r.reply_type === 'preview');
    assert.equal(preview!.status, 'suppressed');
    assert.match(preview!.last_error ?? '', /过时|替代|作废/, '作废原因应可读');
  });

  it('取消后不产生事项，且回复明确说明未保存', async () => {
    await feed('/add 明天下午三点开组会', 'loop-5');
    await runBatch();
    await feed('取消', 'loop-6');
    await runBatch();

    const ev = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM events`);
    assert.equal(ev.rows![0]!.n, 0, '取消不得创建事项');

    await sendPendingReplies(10);
    assert.ok(
      sentTexts.some((t) => /已取消/.test(t)),
      '应告知已取消',
    );
  });

  it('重复确认不产生第二条事项，也不重复发送创建回执', async () => {
    await feed('/add 明天下午三点开组会', 'loop-7');
    await runBatch();
    const draft = await loadActiveOperation(GEN);
    const code = draft!.shortCode!;

    await feed(`确认 ${code}`, 'loop-8');
    await runBatch();
    await feed(`确认 ${code}`, 'loop-9');
    await runBatch();

    const ev = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM events`);
    assert.equal(ev.rows![0]!.n, 1, '不得创建第二个事项');

    await sendPendingReplies(10);
    const createdCount = sentTexts.filter((t) => /已创建/.test(t)).length;
    assert.equal(createdCount, 1, '创建回执只应发出一次');
  });

  it('草稿过期后必须明确告知用户未保存（PRD 3.4）', async () => {
    await feed('/add 明天下午三点开组会', 'loop-exp-1');
    await runBatch();
    const draft = await loadActiveOperation(GEN);
    assert.ok(draft, '应建立草稿');

    // 把草稿的到期时间推到过去，模拟"放了超过 30 分钟"
    await db.execute(
      sql`UPDATE wechat_operations SET expires_at = now() - interval '5 minutes' WHERE id = ${draft!.id}`,
    );

    // 下一条消息会先让过期草稿失效
    await feed('/today', 'loop-exp-2');
    await runBatch();

    // 草稿必须已进入 expired 终态
    const row = await db.execute<{ status: string }>(
      sql`SELECT status FROM wechat_operations WHERE id = ${draft!.id}`,
    );
    assert.equal(row.rows![0]!.status, 'expired');

    // 必须发出过期通知，而不是静默失效
    await sendPendingReplies(10);
    const notice = sentTexts.find((t) => /已过期/.test(t));
    assert.ok(notice, `应告知草稿已过期，实际发出：${JSON.stringify(sentTexts)}`);
    assert.match(notice!, /未保存/, '必须说明未保存');
    assert.match(notice!, /已失效/, '应说明旧短码失效');

    // 过期后用过旧短码确认：不得写库
    await feed(`确认 ${draft!.shortCode}`, 'loop-exp-3');
    await runBatch();
    const ev = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM events`);
    assert.equal(ev.rows![0]!.n, 0, '过期草稿的短码不得写库');
  });

  it('过期通知只发一次（重复处理不重复打扰）', async () => {
    await feed('/add 明天下午三点开组会', 'loop-exp-4');
    await runBatch();
    const draft = await loadActiveOperation(GEN);
    await db.execute(
      sql`UPDATE wechat_operations SET expires_at = now() - interval '5 minutes' WHERE id = ${draft!.id}`,
    );

    await feed('/today', 'loop-exp-5');
    await runBatch();
    await feed('/today', 'loop-exp-6');
    await runBatch();

    await sendPendingReplies(10);
    const notices = sentTexts.filter((t) => /已过期/.test(t));
    assert.equal(notices.length, 1, '过期通知只应发出一次（去重键）');
  });
});

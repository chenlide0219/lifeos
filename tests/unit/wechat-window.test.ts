/**
 * 回复与提醒共用同一发送窗口的集成回归（PRD 16.2、7.3）。
 *
 * 为什么需要这个文件：
 *   提醒走 `notification_jobs` + `core.tick()`，回复走 `wechat_outbox` +
 *   `sendPendingReplies()`，两者**共用同一个 provider 与同一套 8/10 计数**。
 *   各自的单测都通过，但"**混合**发送时计数是否正确累积"这一组合行为**从未被验证**——
 *   而这正是本轮确认的产品规则：每发出一次消息计一次，提醒也一样计入。
 *
 * 手法：只桩化 HTTP（模拟 iLink 端点），其余全部是真实代码与真实数据库，
 * 因此窗口计数、告警、暂停与恢复都会真实发生。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) throw new Error('测试需要 TEST_DATABASE_URL');
if (!new URL(process.env.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('测试库名必须以 _test 结尾');
}
process.env.SESSION_SECRET ??= 'test-secret-at-least-thirty-two-characters-long';

// 旧式通道凭据：让 provider 处于已配置状态（与生产"未扫码"时一致的最简单形态）
process.env.ILINK_TOKEN = 'window-token';
process.env.ILINK_TO_USER_ID = 'window-recipient';
process.env.ILINK_BASE_URL = 'https://ilink.window.test';
process.env.ILINK_CONTEXT_TOKEN = 'window-context';

const { db, pool } = await import('../../src/server/db/client');
const { sql } = await import('drizzle-orm');
const { sendPendingReplies } = await import('../../src/worker/outbox-sender');
const { tick } = await import('../../src/worker/core');
const { enqueueReply } = await import('../../src/server/lib/wechat-outbox');
const { seal } = await import('../../src/server/lib/wechat-state');
const { notificationJobs, notificationRules } = await import('../../src/server/db/schema');

const GEN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const INBOX = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NOW = new Date('2026-10-12T04:00:00Z');

const realFetch = globalThis.fetch;
let sends = 0;
let warningSends = 0;
let texts: string[] = [];

function installFetch(): void {
  sends = 0;
  warningSends = 0;
  texts = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('sendmessage')) {
      sends += 1;
      const body = JSON.parse(String(init?.body)) as {
        msg: { item_list: { text_item: { text: string } }[] };
      };
      const text = body.msg.item_list[0]?.text_item.text ?? '';
      texts.push(text);
      if (text.includes('请刷新微信提醒窗口')) warningSends += 1;
      return new Response(JSON.stringify({ ret: 0, message_id: sends }), { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}

/** 写入"已扫码绑定"状态：扫码头路径与旧式通道共用同一套窗口计数 */
async function installBoundState(generation: string): Promise<void> {
  const state = {
    generation,
    account: seal({
      token: 'window-token',
      userId: 'window-recipient',
      botId: 'lifeos-bot',
      baseUrl: 'https://ilink.window.test',
    }),
    context: seal('window-context'),
    cursor: '',
    revision: 'rev-window',
    seen: [],
    used: 0,
    accepted: 0,
    failed: 0,
    unknown: 0,
    warned: false,
    warningResult: null,
    pausedReason: null,
    boundAt: NOW.getTime(),
    refreshedAt: NOW.getTime(),
    lastInboundTime: NOW.getTime(),
    listenerAt: null,
    listenerError: null,
  };
  await db.execute(sql`
    INSERT INTO settings(key, value) VALUES ('wechat.private-channel', ${JSON.stringify(state)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `);
}

async function readState() {
  const rows = await db.execute<{
    used: number;
    accepted: number;
    warned: boolean;
    paused_reason: string | null;
  }>(sql`
    SELECT (value->>'used')::int AS used,
           (value->>'accepted')::int AS accepted,
           (value->>'warned')::boolean AS warned,
           value->>'pausedReason' AS paused_reason
    FROM settings WHERE key = 'wechat.private-channel'
  `);
  return rows.rows![0]!;
}

async function clean(): Promise<void> {
  await db.execute(sql`DELETE FROM wechat_outbox`);
  await db.execute(sql`DELETE FROM notification_jobs`);
  await db.execute(sql`DELETE FROM notification_rules`);
  await db.execute(sql`DELETE FROM settings WHERE key = 'wechat.private-channel'`);
}

/** 造一条到期的提醒任务，供 core.tick() 领取 */
async function seedReminderJob(key: string, title: string, body: string) {
  const subjectId = crypto.randomUUID();
  const [rule] = await db
    .insert(notificationRules)
    .values({ subjectType: 'event', subjectId, channel: 'wechat', enabled: true })
    .returning({ id: notificationRules.id, subjectId: notificationRules.subjectId });
  const [job] = await db
    .insert(notificationJobs)
    .values({
      ruleId: rule!.id,
      subjectType: 'event',
      subjectId: rule!.subjectId,
      title,
      body,
      // 必须贴近**真实当前时间**：若沿用固定的 NOW，任务会比当前早约 11 小时，
      // 直接触发 MISSED_AFTER_MINUTES=120 的错过判定而被标 missed（既有正确行为），
      // 于是根本走不到"发送"这一步，测不到窗口计数。
      fireAt: new Date(Date.now() - 30_000),
      status: 'pending',
      idempotencyKey: key,
    })
    .returning({ id: notificationJobs.id });
  return job!.id;
}

async function seedReply(key: string, body: string) {
  await enqueueReply(db, {
    bindingGeneration: GEN,
    sourceInboxId: INBOX,
    replyType: 'preview',
    body,
    dedupeKey: key,
    now: NOW,
  });
}

before(async () => {
  await clean();
  installFetch();
});

beforeEach(async () => {
  await clean();
  installFetch();
  await installBoundState(GEN);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(async () => {
  await clean();
  await pool.end();
});

describe('回复与提醒共用同一 8/10 窗口', () => {
  it('提醒与回复混合发送时计数累积到同一上限', async () => {
    // 3 条提醒 + 3 条回复 = 6 次
    for (let i = 0; i < 3; i += 1) await seedReminderJob(`mix-rem-${i}`, `提醒${i}`, '内容');
    for (let i = 0; i < 3; i += 1) await seedReply(`mix-rep-${i}`, `回复${i}`);

    await tick();
    await sendPendingReplies(10, NOW);

    const state = await readState();
    assert.equal(sends, 6, '应一共发出 6 次请求');
    assert.equal(state.used, 6, '提醒与回复必须计入同一个窗口');
    assert.equal(state.warned, false, '未到 8 次不应告警');
  });

  it('总数达到 8 时自动发出刷新提醒，且该提醒也计数', async () => {
    for (let i = 0; i < 5; i += 1) await seedReminderJob(`w8-rem-${i}`, `提醒${i}`, '内容');
    for (let i = 0; i < 3; i += 1) await seedReply(`w8-rep-${i}`, `回复${i}`);

    await tick();
    await sendPendingReplies(10, NOW);

    const state = await readState();
    assert.equal(warningSends, 1, '第 8 次后应恰好发出一条刷新提醒');
    assert.equal(sends, 9, '8 条业务消息 + 1 条刷新提醒 = 9 次');
    assert.equal(state.used, 9, '刷新提醒也必须计数');
    assert.equal(state.warned, true);
    assert.ok(
      texts.some((t) => t.includes('请刷新微信提醒窗口')),
      '刷新提醒的正文应可识别',
    );
  });

  it('达到 10 次后暂停，未发送的回复保持待发送且不伪造送达', async () => {
    // 先塞满 10 次
    for (let i = 0; i < 10; i += 1) await seedReminderJob(`w10-rem-${i}`, `提醒${i}`, '内容');
    await tick();
    const afterFill = await readState();
    assert.ok(afterFill.used >= 10, `应已用满窗口，实际 ${afterFill.used}`);

    // 再来一条回复：应被推迟，不得发出
    await seedReply('w10-rep', '这条应在暂停期间保持待发送');
    const before = sends;
    const result = await sendPendingReplies(10, NOW);

    assert.equal(sends, before, '暂停期间不得发出任何请求');
    assert.equal(result.sent, 0);

    const rows = await db.execute<{ status: string; attempts: number }>(
      sql`SELECT status, attempts FROM wechat_outbox WHERE dedupe_key = 'w10-rep'`,
    );
    assert.equal(rows.rows![0]!.status, 'pending', '应保持待发送，不得伪造已送达');
  });
});

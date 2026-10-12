/**
 * 入站持久化回归测试（PRD 7.1、8.1）。
 *
 * 目标是锁定几个**真实会出错的地方**，而不是走一遍代码：
 *   - 重复投递必须只入库一次（去重靠数据库唯一约束，不靠内存数组）；
 *   - 游标与消息必须同事务：代际不符时**游标也不得推进**；
 *   - 相同文字、不同时间的两条消息是两条合法消息（PRD 3 明确禁止仅凭文本判重）；
 *   - 崩溃留下的 processing 记录必须能靠租约被回收；
 *   - 重试不得改写解析基准（否则重试时"明天"会被重新解释）；
 *   - 正文保留期到期只清正文，保留终态与去重键。
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

// 必须在导入 DB 模块前把连接指向受保护的测试库（与既有测试同一守卫）
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) throw new Error('测试需要 TEST_DATABASE_URL');
if (!new URL(process.env.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('测试库名必须以 _test 结尾');
}

const { db, pool } = await import('../../src/server/db/client');
const { wechatInbox } = await import('../../src/server/db/schema');
const {
  claimInboxBatch,
  deriveProviderMessageId,
  fingerprintOf,
  markInboxDone,
  markInboxFailed,
  purgeExpiredBodies,
  reclaimExpiredLeases,
  inboxCounts,
} = await import('../../src/server/lib/wechat-inbox');
const { emptyWechatState, readWechatState, updateWechatState } = await import('../../src/server/lib/wechat-state');
const { sql } = await import('drizzle-orm');

const GENERATION = '11111111-1111-4111-8111-111111111111';
const OTHER_GENERATION = '22222222-2222-4222-8222-222222222222';
const USER = 'bound-user-1';

/** 直接写入一份已绑定的私有状态，避免依赖真实扫码 */
async function installBoundState(generation: string): Promise<void> {
  await updateWechatState((s) => {
    Object.assign(s, emptyWechatState(), {
      generation,
      account: 'sealed-placeholder',
      boundAt: Date.now(),
      cursor: 'cursor-before',
      context: null,
      used: 0,
      accepted: 0,
      failed: 0,
      unknown: 0,
      seen: [],
      lastInboundTime: 0,
      pausedReason: null,
      warned: false,
      warningResult: null,
      listenerAt: null,
      listenerError: null,
    });
  });
}

/** 清理私有渠道状态，避免污染同库运行的其他测试（尤其是依赖旧式通道的 worker 用例） */
async function clearState(): Promise<void> {
  await db.execute(sql`DELETE FROM settings WHERE key = 'wechat.private-channel'`);
}

const { persistInbound } = await import('../../src/server/lib/wechat-inbox');

function message(overrides: Partial<Parameters<typeof deriveProviderMessageId>[0]> = {}) {
  const text = overrides.text ?? '明天下午三点开组会';
  // 注意：显式传 null 必须保留为 null（不能用 ?? 回退），否则测不到兜底路径
  return {
    providerMessageId: 'providerMessageId' in overrides ? overrides.providerMessageId! : 'msg-1',
    fromUserId: overrides.fromUserId ?? USER,
    messageType: overrides.messageType ?? 1,
    text,
    contextToken: overrides.contextToken ?? 'ctx-token-1',
    providerTimeMs: overrides.providerTimeMs ?? 1_700_000_000_000,
    fingerprint: overrides.fingerprint ?? fingerprintOf(text),
  };
}

before(async () => {
  await db.execute(sql`DELETE FROM wechat_inbox`);
  await db.execute(sql`DELETE FROM wechat_operations`);
  await db.execute(sql`DELETE FROM wechat_outbox`);
  await clearState();
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM wechat_inbox`);
  await db.execute(sql`DELETE FROM wechat_operations`);
  await installBoundState(GENERATION);
});

after(async () => {
  await db.execute(sql`DELETE FROM wechat_inbox`);
  await db.execute(sql`DELETE FROM wechat_operations`);
  // 关键：必须清掉私有状态行。
  // 本文件会写入一个"假的已绑定 account"来测试入库过滤；而 notification provider
  // 一旦看到 account 就会走扫码发送路径（缺少 context 时**推迟**发送），
  // 会让 worker.test.ts 中依赖旧式 ILINK_TOKEN 通道的用例全部失败
  // （表现为任务停在 pending 而不是 failed）。这与 wechat-binding.test.ts 的清理一致。
  await clearState();
  await pool.end();
});

describe('去重键派生', () => {
  it('优先使用提供方消息 ID', () => {
    assert.equal(deriveProviderMessageId(message({ providerMessageId: 'abc' }), GENERATION), 'id:abc');
  });

  it('缺少提供方 ID 时退化为指纹+时间，且不含内容本身', () => {
    const id = deriveProviderMessageId(message({ providerMessageId: null }), GENERATION);
    assert.match(id, /^fp:[0-9a-f]{32}$/);
  });

  it('相同文字但提供方时间不同 → 不同去重键（PRD 3 禁止仅凭文本判重）', () => {
    const a = deriveProviderMessageId(
      message({ providerMessageId: null, providerTimeMs: 1000, text: '明天开会' }),
      GENERATION,
    );
    const b = deriveProviderMessageId(
      message({ providerMessageId: null, providerTimeMs: 2000, text: '明天开会' }),
      GENERATION,
    );
    assert.notEqual(a, b);
  });
});

describe('persistInbound 入库与去重', () => {
  it('首次入库成功，重复投递被唯一约束挡下且不报错', async () => {
    const first = await persistInbound({
      generation: GENERATION,
      messages: [message()],
      receivedAt: new Date('2026-10-12T03:00:00Z'),
      cursor: 'cursor-1',
      context: { token: 'ctx-1', at: new Date('2026-10-12T03:00:00Z'), providerTimeMs: 1_700_000_000_000 },
      boundUserId: USER,
    });
    assert.deepEqual(first, { inserted: 1, duplicated: 0 });

    const second = await persistInbound({
      generation: GENERATION,
      messages: [message()],
      receivedAt: new Date('2026-10-12T03:05:00Z'),
      cursor: 'cursor-2',
      context: null,
      boundUserId: USER,
    });
    assert.deepEqual(second, { inserted: 0, duplicated: 1 });

    const counts = await inboxCounts();
    assert.equal(counts.pending, 1);
  });

  it('非绑定用户与非文本消息不入库', async () => {
    const result = await persistInbound({
      generation: GENERATION,
      messages: [
        message({ providerMessageId: 'm-other', fromUserId: 'someone-else' }),
        message({ providerMessageId: 'm-image', messageType: 3 }),
        message({ providerMessageId: 'm-blank', text: '   ' }),
      ],
      receivedAt: new Date(),
      cursor: 'cursor-x',
      context: null,
      boundUserId: USER,
    });
    assert.equal(result.inserted, 0);
    const counts = await inboxCounts();
    assert.equal(counts.pending ?? 0, 0);
  });

  it('代际不符时既不入库、也不推进游标', async () => {
    const before = await readWechatState();
    const result = await persistInbound({
      generation: OTHER_GENERATION,
      messages: [message({ providerMessageId: 'm-stale' })],
      receivedAt: new Date(),
      cursor: 'cursor-should-not-apply',
      context: null,
      boundUserId: USER,
    });
    assert.equal(result.inserted, 0);

    const after = await readWechatState();
    assert.equal(after.cursor, before.cursor, '代际不符时游标必须保持不动');
    const counts = await inboxCounts();
    assert.equal(counts.pending ?? 0, 0);
  });

  it('游标与上下文在同一次调用中一并推进', async () => {
    await persistInbound({
      generation: GENERATION,
      messages: [message({ providerMessageId: 'm-cursor' })],
      receivedAt: new Date('2026-10-12T03:00:00Z'),
      cursor: 'cursor-advanced',
      context: { token: 'ctx-new', at: new Date('2026-10-12T03:00:00Z'), providerTimeMs: 1_700_000_000_000 },
      boundUserId: USER,
    });
    const state = await readWechatState();
    assert.equal(state.cursor, 'cursor-advanced');
    assert.ok(state.context, '有效消息应刷新上下文');
    assert.equal(state.used, 0, '新消息应重置本轮窗口计数');
    assert.equal(state.warned, false);
  });

  it('解析基准冻结在入站时刻，不随入库时间漂移', async () => {
    const receivedAt = new Date('2026-10-12T03:00:00Z');
    await persistInbound({
      generation: GENERATION,
      messages: [message({ providerMessageId: 'm-basis' })],
      receivedAt,
      cursor: null,
      context: null,
      boundUserId: USER,
    });
    const claimed = await claimInboxBatch(5);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.parseBasisAt.toISOString(), receivedAt.toISOString());
  });
});

describe('领取、终态与租约', () => {
  it('领取后状态为 processing 且 attempts 递增', async () => {
    await persistInbound({
      generation: GENERATION,
      messages: [message({ providerMessageId: 'm-claim' })],
      receivedAt: new Date(),
      cursor: null,
      context: null,
      boundUserId: USER,
    });
    const claimed = await claimInboxBatch(5);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.attempts, 1, '领取一次后 attempts 应为 1');
  });

  it('同一批不会被重复领取', async () => {
    await persistInbound({
      generation: GENERATION,
      messages: [message({ providerMessageId: 'm-single' })],
      receivedAt: new Date(),
      cursor: null,
      context: null,
      boundUserId: USER,
    });
    const first = await claimInboxBatch(5);
    const second = await claimInboxBatch(5);
    assert.equal(first.length, 1);
    assert.equal(second.length, 0, '已领取的 processing 不应被再次领取');
  });

  it('markInboxDone 落终态并清租约', async () => {
    await persistInbound({
      generation: GENERATION,
      messages: [message({ providerMessageId: 'm-done' })],
      receivedAt: new Date(),
      cursor: null,
      context: null,
      boundUserId: USER,
    });
    const [claimed] = await claimInboxBatch(5);
    await markInboxDone(claimed!.id);

    const counts = await inboxCounts();
    assert.equal(counts.done, 1);
    assert.equal(await reclaimExpiredLeases(), 0, 'done 不应被回收');
  });

  it('失败且未耗尽时回到 pending 并写入退避时间', async () => {
    await persistInbound({
      generation: GENERATION,
      messages: [message({ providerMessageId: 'm-retry' })],
      receivedAt: new Date(),
      cursor: null,
      context: null,
      boundUserId: USER,
    });
    const [claimed] = await claimInboxBatch(5);
    const outcome = await markInboxFailed(claimed!.id, '模型超时');
    assert.equal(outcome, 'pending');

    const counts = await inboxCounts();
    assert.equal(counts.pending, 1);
  });

  it('重试耗尽后进入 dead，不阻塞后续消息', async () => {
    await persistInbound({
      generation: GENERATION,
      messages: [message({ providerMessageId: 'm-dead' })],
      receivedAt: new Date(),
      cursor: null,
      context: null,
      boundUserId: USER,
    });
    // 反复领取-失败，直到耗尽
    for (let i = 0; i < 3; i += 1) {
      await db.execute(sql`UPDATE wechat_inbox SET next_attempt_at = NULL WHERE provider_message_id = 'id:m-dead'`);
      const [claimed] = await claimInboxBatch(5);
      if (!claimed) break;
      const outcome = await markInboxFailed(claimed.id, `第 ${i + 1} 次失败`);
      if (outcome === 'dead') break;
    }
    const counts = await inboxCounts();
    assert.equal(counts.dead, 1, '耗尽后应进入 dead 终态');

    // dead 不再被领取
    await db.execute(sql`UPDATE wechat_inbox SET next_attempt_at = NULL`);
    const after = await claimInboxBatch(5);
    assert.equal(after.length, 0);
  });

  it('崩溃留下的 processing 记录可被租约回收', async () => {
    await persistInbound({
      generation: GENERATION,
      messages: [message({ providerMessageId: 'm-crash' })],
      receivedAt: new Date(),
      cursor: null,
      context: null,
      boundUserId: USER,
    });
    await claimInboxBatch(5);
    // 模拟租约过期
    await db.execute(sql`UPDATE wechat_inbox SET leased_until = now() - interval '10 minutes'`);
    const reclaimed = await reclaimExpiredLeases();
    assert.equal(reclaimed, 1);

    const counts = await inboxCounts();
    assert.equal(counts.pending, 1);
  });

  it('租约为 NULL 的 processing 记录也必须被回收（SQL 的 NULL 比较陷阱）', async () => {
    // 真实场景：领取时先置 processing，再单独写租约；进程恰好死在这两步之间，
    // 于是 leased_until 为 NULL。`lt(NULL, now)` 在 SQL 里不成立，
    // 只写"租约已过期"这一条谓词会让该行**永久卡死**、再也不会被领取。
    await persistInbound({
      generation: GENERATION,
      messages: [message({ providerMessageId: 'm-null-lease' })],
      receivedAt: new Date(Date.now() - 30 * 60_000),
      cursor: null,
      context: null,
      boundUserId: USER,
    });
    await db.execute(
      sql`UPDATE wechat_inbox SET status='processing', leased_until=NULL, attempts=1 WHERE provider_message_id='id:m-null-lease'`,
    );

    const reclaimed = await reclaimExpiredLeases();
    assert.equal(reclaimed, 1, 'leased_until 为 NULL 的卡死记录必须被回收');

    const counts = await inboxCounts();
    assert.equal(counts.pending, 1);
    assert.equal(counts.processing ?? 0, 0, '不得再有卡在 processing 的记录');
  });

  it('刚刚置为 processing 且租约为 NULL 的记录不立即回收（避免抢走在途处理）', async () => {
    await persistInbound({
      generation: GENERATION,
      messages: [message({ providerMessageId: 'm-fresh-processing' })],
      receivedAt: new Date(),
      cursor: null,
      context: null,
      boundUserId: USER,
    });
    await db.execute(
      sql`UPDATE wechat_inbox SET status='processing', leased_until=NULL WHERE provider_message_id='id:m-fresh-processing'`,
    );
    const reclaimed = await reclaimExpiredLeases();
    assert.equal(reclaimed, 0, '新近的 processing 不应被误回收');
  });
});

describe('正文保留期', () => {
  it('到期只清正文，保留终态与去重键', async () => {
    await persistInbound({
      generation: GENERATION,
      messages: [message({ providerMessageId: 'm-purge', text: '需要被清理的正文' })],
      receivedAt: new Date(),
      cursor: null,
      context: null,
      boundUserId: USER,
    });
    const [claimed] = await claimInboxBatch(5);
    await markInboxDone(claimed!.id);

    // 把保留期推到过去
    await db.execute(sql`UPDATE wechat_inbox SET purge_after = now() - interval '1 day'`);
    const purged = await purgeExpiredBodies();
    assert.equal(purged.inbox, 1);

    const [row] = await db
      .select({ text: wechatInbox.text, status: wechatInbox.status, providerMessageId: wechatInbox.providerMessageId })
      .from(wechatInbox)
      .limit(1);
    assert.equal(row!.text, '', '正文应被清空');
    assert.equal(row!.status, 'done', '终态必须保留，供最近操作核实');
    assert.equal(row!.providerMessageId, 'id:m-purge', '去重键必须保留，否则旧消息可能被当成新消息重放');
  });
});

/**
 * 回复发送器回归（PRD 7.3、16.2）。
 *
 * 用桩化 HTTP 层（真实 provider 链 + 真实 8/10 窗口计数 + 真实数据库），
 * 因此这里验证的是**发送政策**，而不是某个函数的返回值：
 *   - 换绑/草稿版本变化后，旧回复必须作废而不是迟到送达；
 *   - HTTP 200 但无可靠业务回执 → unknown，**绝不自动重发**；
 *   - 超时/中断 → unknown，同样不重发；
 *   - 明确可重试的失败才重试，并写入退避时间；
 *   - 渠道未配置时不领取、不消费、不伪造送达；
 *   - 空正文（保留期清理后）不得作为空消息发出。
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

const { db, pool } = await import('../../src/server/db/client');
const { users } = await import('../../src/server/db/schema');
const { hashPassword } = await import('../../src/server/lib/password');
const { eq, sql } = await import('drizzle-orm');
const { sendPendingReplies } = await import('../../src/worker/outbox-sender');
const { createOperation, commitOperation } = await import('../../src/server/lib/wechat-operations');
const { enqueueReply } = await import('../../src/server/lib/wechat-outbox');
const { emptyDraft } = await import('../../src/server/lib/wechat-draft');
type Draft = import('../../src/server/lib/wechat-draft').Draft;
const { zonedToInstant } = await import('../../src/server/lib/time');
const { emptyWechatState, seal, updateWechatState } = await import('../../src/server/lib/wechat-state');

const GEN = '99999999-9999-4999-8999-999999999999';
const INBOX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-10-12T04:00:00Z');

/**
 * 归属账号 id（多用户数据隔离）。
 *
 * `wechat_outbox` 与 `wechat_operations` 都带 `user_id NOT NULL`，
 * 而本文件直接用 `enqueueReply` / `createOperation` 造回复与草稿，
 * 因此必须先把账号建出来并把 id 传下去。账号只建一次（clean() 不清理 users），
 * 避免重复运行本文件时撞唯一约束。
 */
let userId = 0;
async function ensureOwner(): Promise<void> {
  if (userId !== 0) return;
  await db
    .insert(users)
    .values({ username: 'outbox-sender', passwordHash: await hashPassword('Outbox-Sender-Pass-1!') })
    .onConflictDoNothing({ target: users.username });
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, 'outbox-sender'))
    .limit(1);
  userId = row!.id;
}

const realFetch = globalThis.fetch;
let sends = 0;
let responder: () => Response | Promise<Response> = () =>
  new Response(JSON.stringify({ ret: 0, message_id: 1 }), { status: 200 });

function installFetch(): void {
  sends = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('sendmessage')) {
      sends += 1;
      return responder();
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}

/**
 * 写入"已扫码绑定"状态（该账号自己那一行 `wechat_accounts`）。
 *
 * 必须用真实的 `seal()` 生成凭据：provider 会真的解密它，
 * 塞占位字符串会在解密阶段抛 TypeError，看起来像发送失败而其实与发送无关。
 * 也必须写 `context`：只写凭据不写上下文只会被判成"等待上下文"，照样不可发送。
 */
async function installBoundState(generation: string): Promise<void> {
  await ensureOwner();
  await updateWechatState(userId, (s) => {
    Object.assign(s, emptyWechatState(userId), {
      generation,
      account: seal({
        token: 'fake-bot-token',
        userId: 'test-recipient',
        botId: 'lifeos-bot',
        baseUrl: 'https://ilink.test.invalid',
      }),
      context: seal('test-context-token'),
      cursor: '',
      // revision 是 uuid 列
      revision: crypto.randomUUID(),
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
    });
  });
}

async function clean(): Promise<void> {
  await db.execute(sql`DELETE FROM wechat_outbox`);
  await db.execute(sql`DELETE FROM wechat_operations`);
  await db.execute(sql`DELETE FROM notification_jobs`);
  await db.execute(sql`DELETE FROM notification_rules`);
  await db.execute(sql`DELETE FROM events`);
  await db.execute(sql`DELETE FROM tasks`);
  // 绑定状态是"每账号一行 wechat_accounts"：按账号删行，避免污染同库其他测试
  await db.execute(sql`DELETE FROM wechat_accounts WHERE user_id = ${userId}`);
}

async function seedReply(options: {
  body?: string;
  generation?: string;
  operationId?: string | null;
  operationVersion?: number | null;
  dedupeKey?: string;
} = {}) {
  await ensureOwner();
  await enqueueReply(db, {
    userId,
    bindingGeneration: options.generation ?? GEN,
    operationId: options.operationId ?? null,
    operationVersion: options.operationVersion ?? null,
    sourceInboxId: INBOX,
    replyType: 'preview',
    body: options.body ?? '这是一条回复',
    dedupeKey: options.dedupeKey ?? `k-${Math.random()}`,
    now: NOW,
  });
  const rows = await db.execute<{ id: string; status: string }>(
    sql`SELECT id, status FROM wechat_outbox ORDER BY created_at DESC LIMIT 1`,
  );
  return rows.rows![0]!;
}

/** 造一个活动草稿用于版本作废测试 */
async function seedOperation(): Promise<{ id: string; version: number }> {
  await ensureOwner();
  const draft: Draft = {
    ...emptyDraft('event'),
    title: '组会',
    startAt: zonedToInstant(2026, 10, 14, 15, 0).toISOString(),
  };
  const created = await createOperation({
    userId,
    bindingGeneration: GEN,
    draftKind: 'event',
    draft,
    missingFields: [],
    shortCode: 'A1B2',
    sourceInboxId: INBOX,
    now: NOW,
  });
  return { id: created!.id, version: created!.version };
}

async function outboxRow(id: string) {
  const rows = await db.execute<{ status: string; failure_kind: string | null; attempts: number; next_attempt_at: string | null; last_error: string | null; sent_at: string | null }>(
    sql`SELECT status, failure_kind, attempts, next_attempt_at, last_error, sent_at FROM wechat_outbox WHERE id = ${id}`,
  );
  return rows.rows![0]!;
}

before(async () => {
  await ensureOwner();
  await clean();
  installFetch();
});

beforeEach(async () => {
  await clean();
  installFetch();
  responder = () => new Response(JSON.stringify({ ret: 0, message_id: 1 }), { status: 200 });
  await installBoundState(GEN);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(async () => {
  await clean();
  await pool.end();
});

describe('过时回复必须作废（PRD 7.3）', () => {
  it('绑定代际已变化 → suppressed，且不发出请求', async () => {
    const row = await seedReply({ generation: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    const result = await sendPendingReplies(5, NOW);

    assert.equal(result.claimed, 1);
    assert.equal(result.suppressed, 1);
    assert.equal(result.sent, 0);
    assert.equal(sends, 0, '作废的回复不得发出网络请求');

    const stored = await outboxRow(row.id);
    assert.equal(stored.status, 'suppressed');
  });

  it('草稿已被新版本替代 → suppressed', async () => {
    const op = await seedOperation();
    // 回复绑定旧版本
    const row = await seedReply({ operationId: op.id, operationVersion: op.version + 1, dedupeKey: 'stale-version' });

    const result = await sendPendingReplies(5, NOW);
    assert.equal(result.suppressed, 1);
    assert.equal(sends, 0);
    assert.equal((await outboxRow(row.id)).status, 'suppressed');
  });

  it('空正文（保留期清理后）→ suppressed，不发出空消息', async () => {
    const row = await seedReply({ body: '   ', dedupeKey: 'empty-body' });
    const result = await sendPendingReplies(5, NOW);
    assert.equal(result.suppressed, 1);
    assert.equal(sends, 0);
    const stored = await outboxRow(row.id);
    assert.equal(stored.status, 'suppressed');
    assert.match(stored.last_error ?? '', /正文/);
  });

  it('代际与版本都正确 → 正常发送', async () => {
    const op = await seedOperation();
    const row = await seedReply({ operationId: op.id, operationVersion: op.version, dedupeKey: 'valid' });
    const result = await sendPendingReplies(5, NOW);

    assert.equal(result.sent, 1);
    assert.equal(result.suppressed, 0);
    assert.equal(sends, 1);
    const stored = await outboxRow(row.id);
    assert.equal(stored.status, 'sent');
    assert.ok(stored.sent_at, '必须记录发送时间');
  });
});

describe('结果未知绝不自动重发（PRD 7.3、16.2）', () => {
  it('HTTP 200 但无可靠业务回执 → unknown 并终止，多轮也不重发', async () => {
    // 缺少 ret/errcode 与 message_id：按政策不得视为成功
    responder = () => new Response(JSON.stringify({ something: 'else' }), { status: 200 });
    const row = await seedReply({ dedupeKey: 'unknown-no-receipt' });

    const first = await sendPendingReplies(5, NOW);
    assert.equal(first.failed, 1, 'unknown 应进入失败终态');

    const stored = await outboxRow(row.id);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.failure_kind, 'unknown');

    // 再跑多轮：不得重发
    await sendPendingReplies(5, new Date(NOW.getTime() + 60_000));
    await sendPendingReplies(5, new Date(NOW.getTime() + 600_000));
    assert.equal(sends, 1, '结果未知的回复只能发出一次');
  });

  it('超时 → unknown 且不重发', async () => {
    responder = () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    };
    const row = await seedReply({ dedupeKey: 'timeout' });

    await sendPendingReplies(5, NOW);
    const stored = await outboxRow(row.id);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.failure_kind, 'unknown', '超时属结果未知');

    await sendPendingReplies(5, new Date(NOW.getTime() + 60_000));
    assert.equal(sends, 1);
  });

  it('发送中中断遗留的 sending → 标记为结果未知，不重发', async () => {
    const row = await seedReply({ dedupeKey: 'interrupted' });
    // 模拟"领取后进程被杀"：状态停在 sending 且租约已过期
    await db.execute(sql`
      UPDATE wechat_outbox
      SET status = 'sending', leased_until = ${new Date(NOW.getTime() - 600_000).toISOString()}, attempts = 1
      WHERE id = ${row.id}
    `);

    const result = await sendPendingReplies(5, NOW);
    assert.equal(result.reclaimed, 1);

    const stored = await outboxRow(row.id);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.failure_kind, 'unknown');
    assert.match(stored.last_error ?? '', /人工核实/);

    assert.equal(sends, 0, '结果未知的记录绝不能被自动重发');
  });
});

describe('可重试与明确拒绝', () => {
  it('明确可重试的失败 → 回到 pending 并写入退避时间', async () => {
    // HTTP 500 属明确可重试
    responder = () => new Response('upstream error', { status: 500 });
    const row = await seedReply({ dedupeKey: 'retryable' });

    const result = await sendPendingReplies(5, NOW);
    assert.equal(result.retried, 1);
    assert.equal(result.failed, 0);

    const stored = await outboxRow(row.id);
    assert.equal(stored.status, 'pending');
    assert.ok(stored.next_attempt_at, '必须写入退避时间');
    assert.ok(new Date(stored.next_attempt_at!).getTime() > NOW.getTime());
  });

  it('重试耗尽后进入失败终态', async () => {
    responder = () => new Response('upstream error', { status: 500 });
    const row = await seedReply({ dedupeKey: 'exhaust' });

    // 反复到期重试，直到耗尽
    let now = NOW;
    for (let i = 0; i < 5; i += 1) {
      await db.execute(sql`UPDATE wechat_outbox SET next_attempt_at = NULL WHERE id = ${row.id}`);
      await sendPendingReplies(5, now);
      now = new Date(now.getTime() + 3_600_000);
    }

    const stored = await outboxRow(row.id);
    assert.equal(stored.status, 'failed', '耗尽后必须进入终态，不能无限重试');
  });

  it('鉴权/上下文被拒（-14，needs_human 类）不重试', async () => {
    // -14 是真实的会话过期/鉴权失败业务码，provider 归类为 auth_or_context → needs_human
    responder = () =>
      new Response(JSON.stringify({ ret: -14, errcode: -14, errmsg: 'session timeout' }), { status: 200 });
    const row = await seedReply({ dedupeKey: 'auth-rejected' });

    await sendPendingReplies(5, NOW);
    const stored = await outboxRow(row.id);
    assert.equal(stored.status, 'failed', '明确鉴权失败必须进入终态');
    assert.equal(stored.failure_kind, 'needs_human');

    await sendPendingReplies(5, new Date(NOW.getTime() + 3_600_000));
    assert.equal(sends, 1, '鉴权失败不得反复重试');
  });

  it('未标明鉴权的业务错误按可重试处理', async () => {
    responder = () =>
      new Response(JSON.stringify({ ret: 401, errcode: 401, errmsg: 'temporary' }), { status: 200 });
    const row = await seedReply({ dedupeKey: 'biz-error' });

    await sendPendingReplies(5, NOW);
    const stored = await outboxRow(row.id);
    assert.equal(stored.status, 'pending');
    assert.equal(stored.failure_kind, 'retryable');
  });
});

describe('渠道未配置时不发送', () => {
  it('无任何凭据时不领取、不发请求、不伪造送达', async () => {
    // 新的"渠道未配置"含义 = 没有任何**可发送**的 wechat_accounts 行：
    // 环境变量 ILINK_* 的全局兜底已被有意移除，因此这里清掉全部绑定行
    // （包括同库其他测试残留的账号，否则它们会让"可发送账号集合"非空）
    await db.execute(sql`DELETE FROM wechat_accounts`);

    const row = await seedReply({ dedupeKey: 'unconfigured' });
    const result = await sendPendingReplies(5, NOW);

    assert.equal(result.claimed, 0, '未配置渠道时不得领取');
    assert.equal(sends, 0);
    const stored = await outboxRow(row.id);
    assert.equal(stored.status, 'pending', '必须保持待发送，不得伪造已送达');
    assert.equal(stored.attempts, 0, '不得记为一次尝试');
  });
});

describe('去重键', () => {
  it('同一条回复重复入队只保留一条', async () => {
    await ensureOwner();
    const first = await enqueueReply(db, {
      userId,
      bindingGeneration: GEN,
      sourceInboxId: INBOX,
      replyType: 'preview',
      body: '第一次',
      dedupeKey: 'same-key',
      now: NOW,
    });
    const second = await enqueueReply(db, {
      userId,
      bindingGeneration: GEN,
      sourceInboxId: INBOX,
      replyType: 'preview',
      body: '第二次',
      dedupeKey: 'same-key',
      now: NOW,
    });
    assert.equal(first, true);
    assert.equal(second, false, '重复入队应返回 false 而不是报错');

    const rows = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM wechat_outbox`);
    assert.equal(rows.rows![0]!.n, 1);
  });
});

void commitOperation;

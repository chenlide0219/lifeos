/**
 * A1 / A2 / A7 回归测试（真实 core.ts + 真实 PostgreSQL + 桩化下游回执）
 *
 * 覆盖验收报告中的真实缺陷：
 * - A1：首次失败使用旧 attempts → 退避取到下标 -1 生成非法时间；上限判断晚一轮，
 *       导致 max_attempts=3 时会出现第 4 次下游调用。
 * - A2（Worker 侧）：无法确认的结果必须终止，绝不自动重发。
 * - A7：渠道未配置时不得领取发送；超阈值过期标 missed 且必须写明原因。
 *
 * 下游只桩化网络层（fetch），业务判定、数据库写入、租约与派发全部是真实代码。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { requireTestDatabase } from '../helpers/guard';

// 硬性守卫：测试库名必须以 _test 结尾，否则直接抛错终止
requireTestDatabase();

const CREDENTIALS = {
  ILINK_TOKEN: 'test-token',
  ILINK_TO_USER_ID: 'test-recipient',
  ILINK_BASE_URL: 'https://ilink.test.invalid',
  MISSED_AFTER_MINUTES: '120',
};
Object.assign(process.env, CREDENTIALS);

const { db, pool } = await import('../../src/server/db/client');
const { notificationJobs, notificationAttempts } = await import('../../src/server/db/schema');
const {
  tick,
  claimDueJobs,
  backoffSecondsFor,
  isExhausted,
  BACKOFF_SECONDS,
} = await import('../../src/worker/core');

const realFetch = globalThis.fetch;
let fetchCalls: number = 0;
let responder: () => Response | Promise<Response> = () => jsonResponse({ ret: 0 });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function withCredentials(): void {
  Object.assign(process.env, CREDENTIALS);
}

function withoutCredentials(): void {
  delete process.env.ILINK_TOKEN;
  delete process.env.ILINK_TO_USER_ID;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE notification_attempts, notification_jobs, notification_rules RESTART IDENTITY CASCADE`,
  );
}

async function insertJob(opts: {
  fireAt: Date;
  key: string;
  maxAttempts?: number;
  ruleId?: string | null;
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(notificationJobs)
    .values({
      ruleId: opts.ruleId ?? null,
      subjectType: 'event',
      subjectId: crypto.randomUUID(),
      title: '测试提醒',
      body: '正文',
      fireAt: opts.fireAt,
      status: 'pending',
      idempotencyKey: opts.key,
      maxAttempts: opts.maxAttempts ?? 3,
    })
    .returning({ id: notificationJobs.id });
  return row!;
}

async function getJob(id: string) {
  const [row] = await db.select().from(notificationJobs).where(eq(notificationJobs.id, id)).limit(1);
  assert.ok(row, `任务 ${id} 应存在`);
  return row!;
}

async function countAttempts(jobId: string): Promise<number> {
  const rows = await db
    .select({ id: notificationAttempts.id })
    .from(notificationAttempts)
    .where(eq(notificationAttempts.jobId, jobId));
  return rows.length;
}

/** 模拟时间流逝：把下次重试时间调到过去，使任务重新可被领取 */
async function forceDue(id: string): Promise<void> {
  await db.execute(
    sql`UPDATE notification_jobs SET next_attempt_at = now() - interval '1 second' WHERE id = ${id}`,
  );
}

beforeEach(async () => {
  await reset();
  withCredentials();
  fetchCalls = 0;
  responder = () => jsonResponse({ ret: 0 });
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return responder();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterEach(async () => {
  await reset();
});

after(async () => {
  await pool.end();
});

describe('A1 退避与上限的纯函数语义', () => {
  it('退避序列按"本次领取后"的次数取下标，首次失败是 60 秒而不是下标 -1', () => {
    assert.equal(backoffSecondsFor(1), 60);
    assert.equal(backoffSecondsFor(2), 300);
    assert.equal(backoffSecondsFor(3), 900);
    // 异常输入不得产生负下标（原缺陷会得到 BACKOFF_SECONDS[-1] → Invalid Date）
    assert.equal(backoffSecondsFor(0), BACKOFF_SECONDS[0]);
    assert.equal(backoffSecondsFor(-1), BACKOFF_SECONDS[0]);
    assert.ok(Number.isFinite(backoffSecondsFor(0)));
  });

  it('上限判断以本次领取后的次数为准：3 次即耗尽', () => {
    assert.equal(isExhausted(1, 3), false);
    assert.equal(isExhausted(2, 3), false);
    assert.equal(isExhausted(3, 3), true);
  });
});

describe('A1 首败退避 / 三次耗尽 / 不出现第四次调用', () => {
  it('首次发送失败按约 60 秒退避，且写入合法的下次重试时间', async () => {
    responder = () => jsonResponse({ ret: 500, errcode: 0 }); // 明确业务错误 → 可重试
    const job = await insertJob({ fireAt: new Date(Date.now() - 1000), key: 'a1-first' });

    const result = await tick();
    const after = await getJob(job.id);

    assert.equal(result.retried, 1);
    assert.equal(after.status, 'pending');
    assert.equal(after.attempts, 1);
    assert.equal(after.failureKind, 'retryable');
    assert.equal(after.leasedUntil, null, '失败后必须释放租约');
    assert.ok(after.nextAttemptAt, '必须有下次重试时间（原缺陷此处为 null 或非法值）');

    const deltaMs = after.nextAttemptAt.getTime() - Date.now();
    assert.ok(deltaMs > 50_000 && deltaMs <= 61_000, `退避应约 60 秒，实际 ${deltaMs}ms`);
    assert.equal(fetchCalls, 1);
    assert.equal(await countAttempts(job.id), 1);
  });

  it('连续失败按 60s → 300s 退避，第 3 次判定耗尽，下游总调用数恰为 3', async () => {
    responder = () => jsonResponse({ ret: 500, errcode: 0 });
    const job = await insertJob({ fireAt: new Date(Date.now() - 1000), key: 'a1-three' });

    await tick();
    let row = await getJob(job.id);
    assert.equal(row.attempts, 1);
    const firstWait = row.nextAttemptAt!.getTime() - Date.now();
    assert.ok(firstWait > 50_000 && firstWait <= 61_000, `第 1 次退避应约 60 秒，实际 ${firstWait}ms`);

    await forceDue(job.id);
    await tick();
    row = await getJob(job.id);
    assert.equal(row.attempts, 2);
    const secondWait = row.nextAttemptAt!.getTime() - Date.now();
    assert.ok(secondWait > 290_000 && secondWait <= 301_000, `第 2 次退避应约 300 秒，实际 ${secondWait}ms`);

    await forceDue(job.id);
    await tick();
    row = await getJob(job.id);
    assert.equal(row.attempts, 3);
    assert.equal(row.status, 'failed');
    assert.equal(row.failureKind, 'exhausted');
    assert.equal(row.nextAttemptAt, null, '耗尽后不得再安排重试');
    assert.match(row.lastError ?? '', /RETRY_EXHAUSTED/);
    assert.equal(fetchCalls, 3, '最多 3 次下游调用，原缺陷会出现第 4 次');

    // 再跑多轮也不应产生新的下游调用
    await tick();
    await tick();
    assert.equal(fetchCalls, 3);
    assert.equal(await countAttempts(job.id), 3);
  });

  it('max_attempts=1 时首次失败即耗尽，恰好 1 次调用', async () => {
    responder = () => jsonResponse({ ret: 500, errcode: 0 });
    const job = await insertJob({ fireAt: new Date(Date.now() - 1000), key: 'a1-max1', maxAttempts: 1 });

    await tick();
    const row = await getJob(job.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.failureKind, 'exhausted');
    assert.equal(fetchCalls, 1);
  });
});

describe('A2 Worker 侧：无法确认的结果绝不自动重发', () => {
  it('HTTP 200 但无成功码 → unknown 并终止，多轮 tick 也不重发', async () => {
    responder = () => jsonResponse({}); // 200 但没有任何业务成功码
    const job = await insertJob({ fireAt: new Date(Date.now() - 1000), key: 'a2-empty-body' });

    await tick();
    const row = await getJob(job.id);

    assert.equal(row.status, 'failed', 'HTTP 200 绝不能被记为 sent');
    assert.equal(row.failureKind, 'unknown');
    assert.match(row.lastError ?? '', /UNKNOWN_MAYBE_DELIVERED/);
    assert.equal(row.nextAttemptAt, null, 'unknown 不得安排重试');
    assert.equal(fetchCalls, 1);

    await tick();
    await tick();
    assert.equal(fetchCalls, 1, 'UNKNOWN 绝不自动重发');
  });

  it('超时 → unknown 且不重发', async () => {
    responder = () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    };
    const job = await insertJob({ fireAt: new Date(Date.now() - 1000), key: 'a2-timeout' });

    await tick();
    const row = await getJob(job.id);

    assert.equal(row.status, 'failed');
    assert.equal(row.failureKind, 'unknown');
    assert.match(row.lastError ?? '', /timeout_remote_may_have_accepted/);
    assert.equal(fetchCalls, 1);

    await tick();
    assert.equal(fetchCalls, 1);
  });

  it('鉴权失败 → needs_human 并终止，不重试', async () => {
    responder = () => jsonResponse({ ret: -2, errcode: -14 });
    const job = await insertJob({ fireAt: new Date(Date.now() - 1000), key: 'a2-auth' });

    await tick();
    const row = await getJob(job.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.failureKind, 'needs_human');
    assert.equal(fetchCalls, 1);
  });

  it('业务接受 → sent，且清除失败痕迹', async () => {
    responder = () => jsonResponse({ ret: 0 });
    const job = await insertJob({ fireAt: new Date(Date.now() - 1000), key: 'a2-ok' });

    const result = await tick();
    const row = await getJob(job.id);
    assert.equal(result.sent, 1);
    assert.equal(row.status, 'sent');
    assert.equal(row.failureKind, null);
    assert.ok(row.sentAt);
  });
});

describe('A1 租约回收：发送中断不盲目重发', () => {
  it('租约过期的 sending 任务标记为结果未知，且不产生下游调用', async () => {
    const job = await insertJob({ fireAt: new Date(Date.now() - 1000), key: 'a1-lease' });
    // 手工制造"Worker 在发送中中断"的现场
    await db.execute(sql`
      UPDATE notification_jobs
      SET status = 'sending', attempts = 1, leased_until = now() - interval '1 minute'
      WHERE id = ${job.id}
    `);

    const result = await tick();
    const row = await getJob(job.id);

    assert.equal(result.reclaimed, 1);
    assert.equal(row.status, 'failed');
    assert.equal(row.failureKind, 'unknown');
    assert.match(row.lastError ?? '', /WORKER_INTERRUPTED_DURING_SEND/);
    assert.equal(row.leasedUntil, null);
    assert.equal(fetchCalls, 0, '结果未知的任务不得被重发');
  });
});

describe('A1 并发领取不重复', () => {
  it('两个并发领取同一任务，合计只领取一次且 attempts 只加一', async () => {
    const job = await insertJob({ fireAt: new Date(Date.now() - 1000), key: 'a1-concurrent' });

    const [a, b] = await Promise.all([claimDueJobs(), claimDueJobs()]);
    assert.equal(a.length + b.length, 1, '同一任务只能被一个领取者拿到');

    const row = await getJob(job.id);
    assert.equal(row.attempts, 1, 'attempts 只能 +1');
    assert.equal(row.status, 'sending');
  });
});

describe('A7 未配置渠道 / 错过阈值 / 渠道恢复', () => {
  it('渠道未配置时不领取任务：不消费、不记尝试、不发请求', async () => {
    withoutCredentials();
    const job = await insertJob({ fireAt: new Date(Date.now() - 1000), key: 'a7-unconfigured' });

    const result = await tick();
    const row = await getJob(job.id);

    assert.equal(result.skippedUnconfigured, true);
    assert.equal(result.claimed, 0);
    assert.equal(row.status, 'pending', '未配置时任务必须留在 pending');
    assert.equal(row.attempts, 0, '不得计入尝试次数');
    assert.equal(fetchCalls, 0);
    assert.equal(await countAttempts(job.id), 0);
  });

  it('未配置且已超过错过阈值 → 标记 missed 并写明"通道未配置"原因', async () => {
    withoutCredentials();
    const job = await insertJob({ fireAt: new Date(Date.now() - 3 * 3600 * 1000), key: 'a7-missed' });

    const result = await tick();
    const row = await getJob(job.id);

    assert.equal(result.missed, 1);
    assert.equal(row.status, 'missed');
    assert.match(row.lastError ?? '', /未配置/);
    assert.match(row.lastError ?? '', /不补发/);
    assert.equal(fetchCalls, 0);
  });

  it('刚到期但未超阈值 → 保持 pending，不被误标 missed', async () => {
    withoutCredentials();
    const job = await insertJob({ fireAt: new Date(Date.now() - 60_000), key: 'a7-just-due' });

    await tick();
    const row = await getJob(job.id);
    assert.equal(row.status, 'pending', '阈值内的任务不应被标记错过');
    assert.equal(row.attempts, 0);
  });

  it('渠道恢复后（补上凭据，无需重启）同一任务被正常发送', async () => {
    withoutCredentials();
    const job = await insertJob({ fireAt: new Date(Date.now() - 60_000), key: 'a7-recovery' });

    await tick();
    assert.equal((await getJob(job.id)).status, 'pending');

    // 补上凭据 = 运维在 .env 填写 ILINK_*
    withCredentials();
    responder = () => jsonResponse({ ret: 0 });
    await tick();

    const row = await getJob(job.id);
    assert.equal(row.status, 'sent');
    assert.equal(row.sentAt !== null, true);
    assert.equal(fetchCalls, 1);
  });

  it('已配置渠道下超阈值的任务同样标 missed 并写明原因（服务中断场景）', async () => {
    withCredentials();
    const job = await insertJob({ fireAt: new Date(Date.now() - 3 * 3600 * 1000), key: 'a7-outage' });

    await tick();
    const row = await getJob(job.id);
    assert.equal(row.status, 'missed');
    assert.match(row.lastError ?? '', /超过错过阈值/);
    assert.equal(fetchCalls, 0, '错过的提醒不补发');
  });
});

describe('退出策略：停止领取后已领取任务交还 pending', () => {
  it('shuttingDown 时已领取但未发送的任务回到 pending 且 attempts 回退', async () => {
    const job = await insertJob({ fireAt: new Date(Date.now() - 1000), key: 'exit-release' });

    const result = await tick({ shuttingDown: true });
    const row = await getJob(job.id);

    assert.equal(result.released, 1);
    assert.equal(result.sent, 0);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 0, '未发送不应消耗尝试次数');
    assert.equal(fetchCalls, 0);
  });
});

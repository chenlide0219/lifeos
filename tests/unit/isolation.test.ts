/**
 * 多用户数据隔离回归（阶段 2 的核心验收）。
 *
 * 为什么单独写一个文件：数据库能挡住"写错归属"，但**挡不住"查询忘了过滤"**，
 * 而后者才是跨用户泄露真正会发生的地方。本文件的作用就是逐个端点证明
 * "bob 看不见 alice 的任何东西"，并把这件事固定成回归测试。
 *
 * 断言策略（刻意与各端点响应结构解耦）：
 *   alice 的所有数据里都带一个唯一哨兵字符串。bob 的**每一个**读取端点，
 *   都断言响应正文里不出现该哨兵。这样即使将来某个端点改了响应字段名，
 *   只要它泄露了 alice 的数据，测试就会失败——不需要维护每个端点的字段清单。
 *   在此之上，对按 id 访问的端点再断言状态码（别人的资源与不存在必须**同样**是 404，
 *   用 403 区分等于向调用者确认"这个 id 存在"）。
 */
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { requireTestDatabase } from '../helpers/guard';

requireTestDatabase();

const { db, pool } = await import('../../src/server/db/client');
const { createApp } = await import('../../src/server/app');
const { users } = await import('../../src/server/db/schema');
const { hashPassword } = await import('../../src/server/lib/password');

const app = createApp();
const PASSWORD = 'Isolation-Test-Pass-1!';

/** alice 数据里的唯一标记：bob 的任何响应都不该出现它 */
const S = 'ALICE-SENTINEL-7f3a';

let aliceCookie = '';
let bobCookie = '';
let aliceId = 0;
let bobId = 0;

function as(cookie: string) {
  return (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(init.headers ?? {}),
      },
    });
}

const alice = (path: string, init?: RequestInit) => as(aliceCookie)(path, init);
const bob = (path: string, init?: RequestInit) => as(bobCookie)(path, init);

async function login(username: string): Promise<string> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(res.status, 200, `${username} 应能登录`);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  assert.ok(cookie.startsWith('lifeos_session='), '应拿到会话 Cookie');
  return cookie;
}

/** 断言 bob 的响应里没有 alice 的哨兵；返回解出的 JSON（若为 JSON） */
async function expectNoLeak(res: Response, label: string): Promise<string> {
  const text = await res.text();
  assert.ok(
    !text.includes(S),
    `${label} 泄露了 alice 的数据（响应中出现哨兵 ${S}）：${text.slice(0, 400)}`,
  );
  return text;
}

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

beforeEach(async () => {
  // CASCADE 会连带清空所有归属表（它们都外键指向 users）
  await db.execute(sql`TRUNCATE users, sessions, audit_logs RESTART IDENTITY CASCADE`);

  const inserted = (await db
    .insert(users)
    .values([
      { username: 'iso-alice', passwordHash: await hashPassword(PASSWORD), isAdmin: true },
      { username: 'iso-bob', passwordHash: await hashPassword(PASSWORD) },
    ])
    .returning({ id: users.id, username: users.username })) as { id: number; username: string }[];
  aliceId = inserted.find((u) => u.username === 'iso-alice')!.id;
  bobId = inserted.find((u) => u.username === 'iso-bob')!.id;

  aliceCookie = await login('iso-alice');
  bobCookie = await login('iso-bob');
});

after(async () => {
  await db.execute(sql`TRUNCATE users, sessions, audit_logs RESTART IDENTITY CASCADE`);
  await pool.end();
});

/**
 * 以 alice 的身份造一份覆盖各业务表的数据，返回各资源的 id。
 *
 * 注意每个响应体只读一次：`assert.equal(x, y, \`...${await res.text()}\`)` 里的模板
 * 字符串是**先求值**再传给断言的，会把 body 读掉，后面再 `.json()` 就报
 * "Body is unusable"。因此统一"先 text() 一次，再 JSON.parse"。
 */
async function seedAlice(): Promise<{
  eventId: string;
  taskId: string;
  subscriptionId: string;
  billId: string;
  paymentId: string;
  jobId: string;
}> {
  async function post(path: string, payload: unknown, label: string): Promise<Record<string, unknown>> {
    const res = await alice(path, { method: 'POST', body: JSON.stringify(payload) });
    const text = await res.text();
    assert.equal(res.status, 201, `${label} 应成功（${res.status}）：${text}`);
    return JSON.parse(text) as Record<string, unknown>;
  }

  const eventBody = await post(
    '/api/events',
    {
      title: `${S} 事件`,
      startAt: hoursFromNow(48),
      location: `${S} 地点`,
      reminderEnabled: true,
      reminderOffsets: [60, 10],
    },
    'alice 建事件',
  );
  const event = eventBody.event as { id: string };

  const taskBody = await post(
    '/api/tasks',
    { title: `${S} 待办`, dueDate: '2030-06-01', dueTime: '09:00' },
    'alice 建待办',
  );
  const task = taskBody.task as { id: string };

  const subBody = await post(
    '/api/subscriptions',
    {
      name: `${S} 订阅`,
      price: '20.00',
      currency: 'USD',
      billingPeriod: 'monthly',
      anchorDate: '2026-01-31',
      note: `${S} 备注`,
    },
    'alice 建订阅',
  );
  const subscription = subBody.subscription as { id: string };

  const billsRes = await alice(`/api/subscriptions/bills/list?status=expected`);
  const { bills } = (await billsRes.json()) as { bills: { id: string; subscriptionId: string }[] };
  const bill = bills.find((b) => b.subscriptionId === subscription.id);
  assert.ok(bill, 'alice 的订阅应生成预计账单');

  const payBody = await post(
    '/api/subscriptions/payments',
    {
      subscriptionId: subscription.id,
      paidAt: '2026-02-01',
      amount: '20.00',
      currency: 'USD',
      note: `${S} 付款`,
    },
    'alice 记一笔付款',
  );
  const payment = payBody.payment as { id: string };

  // 事件带提醒 → 应生成提醒任务
  const jobsRes = await alice('/api/notifications/jobs');
  const jobsBody = (await jobsRes.json()) as { jobs: { id: string }[] };
  assert.ok(jobsBody.jobs.length > 0, 'alice 的事件提醒应生成通知任务');

  return {
    eventId: event.id,
    taskId: task.id,
    subscriptionId: subscription.id,
    billId: bill.id,
    paymentId: payment.id,
    jobId: jobsBody.jobs[0]!.id,
  };
}

describe('多用户数据隔离', () => {
  it('bob 的每一个读取端点都不出现 alice 的数据（哨兵扫描）', async () => {
    await seedAlice();

    const now = new Date();
    // 范围要覆盖 alice 的种子数据（事件在 +48h），但**不能超过日历接口的跨度上限**
    // （过大的范围会被 400 拒绝，那是防"一次拉走整库"的保护）
    const from = new Date(now.getTime() - 10 * 86_400_000).toISOString();
    const to = new Date(now.getTime() + 50 * 86_400_000).toISOString();

    const endpoints: [string, string][] = [
      ['/api/events?limit=200', '事件列表'],
      ['/api/tasks?view=inbox', '待办-收件箱'],
      ['/api/tasks?view=today', '待办-今天'],
      ['/api/tasks?view=upcoming', '待办-未来'],
      ['/api/tasks/counts', '待办计数'],
      [`/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, '日历聚合'],
      ['/api/calendar/overview', '日历总览'],
      ['/api/subscriptions', '订阅列表'],
      ['/api/subscriptions/summary', '订阅汇总'],
      ['/api/subscriptions/bills/list', '预计账单列表'],
      ['/api/subscriptions/payments/list', '付款列表'],
      ['/api/subscriptions/analytics/summary', '支出统计'],
      ['/api/notifications/jobs', '通知任务列表'],
      ['/api/imports/batches', '导入批次列表'],
      ['/api/export/data.json', '业务数据导出'],
      ['/api/export/subscriptions.csv', '订阅 CSV 导出'],
      ['/api/export/payments.csv', '付款 CSV 导出'],
      ['/api/wechat/assistant', '微信助手状态'],
    ];

    for (const [path, label] of endpoints) {
      const res = await bob(path);
      assert.ok(res.status < 400, `${label}（${path}）应可正常访问，实际 ${res.status}`);
      await expectNoLeak(res, label);
    }
  });

  it('按 id 直接访问 alice 的资源：读/改/删一律 404，且不得泄露存在性', async () => {
    const ids = await seedAlice();

    const attempts: [string, string, RequestInit?][] = [
      ['GET', `/api/events/${ids.eventId}`],
      ['PATCH', `/api/events/${ids.eventId}`, { body: JSON.stringify({ title: '被篡改' }) }],
      ['POST', `/api/events/${ids.eventId}/cancel`],
      ['DELETE', `/api/events/${ids.eventId}`],
      ['GET', `/api/tasks/${ids.taskId}`],
      ['PATCH', `/api/tasks/${ids.taskId}`, { body: JSON.stringify({ title: '被篡改' }) }],
      ['POST', `/api/tasks/${ids.taskId}/complete`],
      ['DELETE', `/api/tasks/${ids.taskId}`],
      ['GET', `/api/subscriptions/${ids.subscriptionId}`],
      ['PATCH', `/api/subscriptions/${ids.subscriptionId}`, { body: JSON.stringify({ name: '被篡改' }) }],
      ['DELETE', `/api/subscriptions/${ids.subscriptionId}`],
      ['GET', `/api/notifications/jobs/${ids.jobId}/attempts`],
    ];

    for (const [method, path, init] of attempts) {
      const res = await bob(path, { method, ...(init ?? {}) });
      assert.equal(res.status, 404, `${method} ${path} 对别人的资源应返回 404，实际 ${res.status}`);
      await expectNoLeak(res, `${method} ${path}`);
    }
  });

  it('bob 不能被诱导把数据挂到 alice 的资源上', async () => {
    const ids = await seedAlice();

    // 用 alice 的订阅 id 记一笔付款：与"订阅不存在"必须返回完全一致的结果
    const pay = await bob('/api/subscriptions/payments', {
      method: 'POST',
      body: JSON.stringify({
        subscriptionId: ids.subscriptionId,
        paidAt: '2026-03-01',
        amount: '1.00',
        currency: 'USD',
      }),
    });
    assert.equal(pay.status, 400, '指定别人的订阅应被拒绝');
    await expectNoLeak(pay, '借用他人订阅记账');

    // 确认 alice 的订阅上没有被挂上任何付款
    const alicePayments = await alice('/api/subscriptions/payments/list');
    const body = (await alicePayments.json()) as { payments: { note: string | null }[] };
    assert.equal(
      body.payments.filter((p) => p.note === null).length,
      0,
      'bob 的付款请求不得在 alice 的订阅下留下记录',
    );

    // 确认 alice 的账单没有被 bob 确认付款
    const confirm = await bob(`/api/subscriptions/bills/${ids.billId}/confirm`, { method: 'POST' });
    assert.ok(confirm.status >= 400, `确认别人的账单必须失败，实际 ${confirm.status}`);
    await expectNoLeak(confirm, '确认他人账单');

    const bills = await alice('/api/subscriptions/bills/list?status=expected');
    const { bills: aliceBills } = (await bills.json()) as { bills: { id: string; status: string }[] };
    assert.equal(
      aliceBills.find((b) => b.id === ids.billId)?.status,
      'expected',
      'alice 的账单必须仍是"预计"，不能被 bob 改成已付款',
    );
  });

  it('bob 的攻击失败后，alice 的数据完好无损', async () => {
    const ids = await seedAlice();

    // 让 bob 把所有能试的都试一遍
    await bob(`/api/events/${ids.eventId}`, { method: 'DELETE' });
    await bob(`/api/events/${ids.eventId}`, { method: 'PATCH', body: JSON.stringify({ title: 'x' }) });
    await bob(`/api/tasks/${ids.taskId}`, { method: 'DELETE' });
    await bob(`/api/subscriptions/${ids.subscriptionId}`, { method: 'DELETE' });

    const event = await alice(`/api/events/${ids.eventId}`);
    assert.equal(event.status, 200, 'alice 的事件必须仍然存在');
    const eventBody = (await event.json()) as { event: { title: string; status: string } };
    assert.equal(eventBody.event.title, `${S} 事件`, 'alice 的事件标题不得被改动');
    assert.equal(eventBody.event.status, 'active', 'alice 的事件不得被取消');

    const task = await alice(`/api/tasks/${ids.taskId}`);
    assert.equal(task.status, 200, 'alice 的待办必须仍然存在');

    const sub = await alice(`/api/subscriptions/${ids.subscriptionId}`);
    assert.equal(sub.status, 200, 'alice 的订阅必须仍然存在');
  });

  it('导出只含本人数据：bob 的导出里各表计数为 0', async () => {
    await seedAlice();

    const res = await bob('/api/export/data.json');
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      counts: Record<string, number>;
      data: Record<string, unknown[]>;
      scope?: string;
    };
    await expectNoLeak(new Response(JSON.stringify(body)), '业务数据导出');

    for (const [table, count] of Object.entries(body.counts)) {
      // `settings` 是**全局表**（没有 user_id），不属于任何账号，因此它的行出现在每个人
      // 的导出里是正常且必要的（否则界面配置会丢）。这里只断言"按账号归属的表"为 0。
      // 这条区分不是可有可无：本断言曾在本地通过、在服务器上失败——因为本地每次重建
      // schema 后 settings 恰好是空的，掩盖了"全局表本来就会有行"这一事实。
      if (table === 'settings') continue;
      assert.equal(count, 0, `bob 的导出里 ${table} 应为 0 行，实际 ${count}`);
    }
    for (const [table, rows] of Object.entries(body.data)) {
      if (table === 'settings') continue;
      assert.equal(rows.length, 0, `bob 的导出里 ${table} 不应有任何行`);
    }

    // 全局表里也绝不能出现微信绑定凭据（它是私有状态，导出时被排除）
    const settingsRows = (body.data.settings ?? []) as { key?: string }[];
    assert.ok(
      !settingsRows.some((r) => r.key === 'wechat.private-channel'),
      '导出中不得出现微信绑定凭据行',
    );

    // alice 的导出则必须有数据（否则这条测试可能只是"导出坏了"）
    const aliceRes = await alice('/api/export/data.json');
    const aliceBody = (await aliceRes.json()) as { counts: Record<string, number> };
    assert.ok(aliceBody.counts.events! > 0, 'alice 的导出应包含自己的事件');
  });

  it('数据库层：跨账号错配被复合外键拒绝（不依赖应用判断）', async () => {
    const ids = await seedAlice();

    // 绕过所有应用逻辑，直接写库：账单归属改为另一个账号
    await assert.rejects(
      async () => {
        await db.execute(sql`
          INSERT INTO expected_bills (subscription_id, user_id, planned_date, amount, currency)
          VALUES (${ids.subscriptionId}::uuid, ${bobId}, '2031-01-01', 1.00, 'USD')
        `);
      },
      /foreign key|violates/i,
      '账单归属与订阅归属不一致时，必须被数据库拒绝',
    );

    // 提醒任务的归属也不能与它的规则不一致
    const job = (await db.execute(
      sql`SELECT rule_id FROM notification_jobs WHERE user_id = ${aliceId} LIMIT 1`,
    )) as unknown as { rows: { rule_id: string }[] };
    assert.ok(job.rows[0]?.rule_id, 'alice 的提醒任务应挂在某条规则上');
    await assert.rejects(
      async () => {
        await db.execute(sql`
          INSERT INTO notification_jobs (rule_id, user_id, subject_type, subject_id, title, body, fire_at, idempotency_key)
          VALUES (${job.rows[0]!.rule_id}::uuid, ${bobId}, 'event', ${ids.eventId}::uuid, '错配', '正文', now(), 'iso-mismatch-key')
        `);
      },
      /foreign key|violates/i,
      '任务归属与规则归属不一致时，必须被数据库拒绝',
    );
  });

  it('数据库层：没有任何业务行缺少归属', async () => {
    await seedAlice();

    const OWNED = [
      'events',
      'tasks',
      'subscriptions',
      'subscription_price_history',
      'expected_bills',
      'payments',
      'csv_import_batches',
      'notification_rules',
      'notification_jobs',
      'notification_attempts',
      'wechat_inbox',
      'wechat_operations',
      'wechat_outbox',
    ];
    for (const table of OWNED) {
      const rows = (await db.execute(
        sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE user_id IS NULL`),
      )) as unknown as { rows: { n: number }[] };
      assert.equal(rows.rows[0]?.n, 0, `${table} 不应存在 user_id 为空的行`);
    }

    // 反向确认种子数据确实写进去了（否则上面的断言可能因为"库里没数据"而空转）
    const seeded = (await db.execute(
      sql`SELECT count(*)::int AS n FROM events WHERE user_id = ${aliceId}`,
    )) as unknown as { rows: { n: number }[] };
    assert.ok((seeded.rows[0]?.n ?? 0) > 0, 'alice 的事件应已写入');
  });

  it('两个账号的数据可以并存，且各自只能看到自己的', async () => {
    await seedAlice();

    // bob 也建一个事件与一个订阅
    const bobEvent = await bob('/api/events', {
      method: 'POST',
      body: JSON.stringify({ title: 'BOB 的事件', startAt: hoursFromNow(72) }),
    });
    assert.equal(bobEvent.status, 201);

    const aliceList = await alice('/api/events?limit=200');
    const aliceText = await aliceList.text();
    assert.ok(aliceText.includes(`${S} 事件`), 'alice 应看到自己的事件');
    assert.ok(!aliceText.includes('BOB 的事件'), 'alice 不应看到 bob 的事件');

    const bobList = await bob('/api/events?limit=200');
    const bobText = await bobList.text();
    assert.ok(bobText.includes('BOB 的事件'), 'bob 应看到自己的事件');
    assert.ok(!bobText.includes(S), 'bob 不应看到 alice 的事件');
  });
});

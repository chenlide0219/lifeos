/**
 * 阶段 6 回归：数据导出（PRD FR-08）。
 *
 * 两条最要紧的约束：
 *   1. **绝不导出凭据材料**（密码哈希、会话令牌）——导出文件会被搬来搬去；
 *   2. CSV 单元格必须正确转义，且防止被表格软件当作公式执行。
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { requireTestDatabase } from '../helpers/guard';

requireTestDatabase();

const { db, pool } = await import('../../src/server/db/client');
const { createApp } = await import('../../src/server/app');
const { users } = await import('../../src/server/db/schema');
const { hashPassword } = await import('../../src/server/lib/password');
const { toCsv } = await import('../../src/server/lib/csv');

const app = createApp();
const PASSWORD = 'Export-Test-Pass-1!';
let cookie = '';

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
}

before(async () => {
  await db.execute(sql`TRUNCATE users, sessions, audit_logs RESTART IDENTITY CASCADE`);
  await db.insert(users).values({ username: 'export-test', passwordHash: await hashPassword(PASSWORD) });
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'export-test', password: PASSWORD }),
  });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  assert.ok(cookie.startsWith('lifeos_session='));
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE notification_attempts, notification_jobs, notification_rules,
        payments, expected_bills, subscription_price_history, subscriptions, events, tasks
        RESTART IDENTITY CASCADE`,
  );
});

after(async () => {
  await db.execute(sql`TRUNCATE users, sessions, audit_logs RESTART IDENTITY CASCADE`);
  await pool.end();
});

describe('CSV 生成与转义', () => {
  it('含逗号、引号、换行的字段被正确转义', () => {
    const csv = toCsv(['a', 'b'], [['含,逗号', '含"引号"'], ['含\n换行', '普通']], { bom: false });
    assert.equal(csv, 'a,b\r\n"含,逗号","含""引号"""\r\n"含\n换行",普通\r\n');
  });

  it('以 = + - @ 开头的值被加上前导单引号，避免被表格软件当公式执行', () => {
    const csv = toCsv(['v'], [['=1+1'], ['+cmd'], ['-2'], ['@SUM(A1)']], { bom: false });
    assert.match(csv, /'=1\+1/);
    assert.match(csv, /'\+cmd/);
    assert.match(csv, /'-2/);
    assert.match(csv, /'@SUM\(A1\)/);
  });

  it('空值导出为空单元格而不是 null/undefined 字样', () => {
    const csv = toCsv(['a', 'b'], [[null, undefined]], { bom: false });
    assert.equal(csv, 'a,b\r\n,\r\n');
  });

  it('默认带 UTF-8 BOM，Excel 打开中文不乱码', () => {
    const withBom = toCsv(['中文'], [['值']]);
    assert.equal(withBom.charCodeAt(0), 0xfeff);
    const withoutBom = toCsv(['中文'], [['值']], { bom: false });
    assert.notEqual(withoutBom.charCodeAt(0), 0xfeff);
  });
});

describe('导出接口', () => {
  it('订阅 CSV 带附件头与正确内容类型', async () => {
    await request('/api/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ name: 'ChatGPT Plus', price: '20.00', currency: 'USD', billingPeriod: 'monthly', anchorDate: '2026-01-31' }),
    });

    const res = await request('/api/export/subscriptions.csv');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="lifeos-subscriptions-/);

    // 注意：Response.text() 会按规范剥掉 BOM，验 BOM 必须看原始字节
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], '应带 UTF-8 BOM');

    const text = buf.toString('utf8');
    assert.match(text, /ChatGPT Plus/);
    assert.match(text, /服务名称/);
  });

  it('付款 CSV 导出退款与汇率快照信息', async () => {
    await request('/api/subscriptions/payments', {
      method: 'POST',
      body: JSON.stringify({ paidAt: '2030-01-01', amount: '20.00', currency: 'USD', fxRate: '7.5', fxRateSource: '手动' }),
    });

    const text = await (await request('/api/export/payments.csv')).text();
    assert.match(text, /是否退款/);
    assert.match(text, /人民币金额为估算/);
    assert.match(text, /20\.00/);
    assert.match(text, /7\.5/);
  });

  it('完整 JSON 导出包含各业务表与计数', async () => {
    // 锚点需落在 12 个月滚动范围内，否则（正确地）产不出预计账单
    await request('/api/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ name: 'Netflix', price: '10.00', currency: 'USD', billingPeriod: 'monthly', anchorDate: '2026-01-31' }),
    });
    await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: '导出用待办' }) });

    const res = await request('/api/export/data.json');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /lifeos-data-.*\.json/);

    const body = (await res.json()) as {
      schema: string;
      counts: Record<string, number>;
      excluded: string[];
      data: Record<string, unknown[]>;
    };
    assert.equal(body.schema, 'lifeos-export/1');
    assert.equal(body.counts.tasks, 1);
    assert.equal(body.counts.subscriptions, 1);
    assert.ok(body.counts.expectedBills > 0, `订阅应带动预计账单一起导出，实际 ${body.counts.expectedBills}`);
    assert.ok(Array.isArray(body.data.events));
    assert.ok(body.exportedAt);
  });
});

describe('导出绝不含凭据材料', () => {
  it('JSON 导出中不出现密码哈希与会话令牌字段', async () => {
    // 取出真实的密码哈希值，用它来验证"导出里确实没有这个值"
    const hashRow = (await db.execute(
      sql`SELECT password_hash FROM users LIMIT 1`,
    )) as unknown as { rows: { password_hash: string }[] };
    const realHash = hashRow.rows[0]!.password_hash;

    await db.execute(sql`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES ((SELECT id FROM users LIMIT 1), 'super-secret-token-hash', now() + interval '1 day')
    `);

    const raw = await (await request('/api/export/data.json')).text();
    const body = JSON.parse(raw) as { excluded: string[]; data: Record<string, unknown> };

    // 关键断言：真实凭据值不得出现在导出里
    assert.ok(!raw.includes(realHash), '不得导出密码哈希的真实值');
    assert.doesNotMatch(raw, /super-secret-token-hash/, '不得导出会话令牌');

    // 数据区里不应存在这些表
    assert.ok(!('users' in body.data), '数据区不应包含管理员表');
    assert.ok(!('sessions' in body.data), '数据区不应包含会话表');

    // 同时把"排除了什么"明确写进导出文件，避免使用者误以为这就是全部
    assert.ok(body.excluded.includes('users.password_hash'));
    assert.ok(body.excluded.includes('sessions'));
  });

  it('清单接口说明导出包含什么、排除了什么', async () => {
    const body = (await (await request('/api/export/manifest')).json()) as {
      endpoints: { path: string }[];
      excluded: string[];
      csvNotes: string[];
    };
    assert.equal(body.endpoints.length, 3);
    assert.ok(body.excluded.includes('sessions'));
    assert.ok(body.csvNotes.some((n) => n.includes('公式')));
  });

  it('导出接口均需登录', async () => {
    const saved = cookie;
    cookie = '';
    try {
      for (const path of ['/api/export/subscriptions.csv', '/api/export/payments.csv', '/api/export/data.json', '/api/export/manifest']) {
        assert.equal((await request(path)).status, 401, `${path} 应要求登录`);
      }
    } finally {
      cookie = saved;
    }
  });
});

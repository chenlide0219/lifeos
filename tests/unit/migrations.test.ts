/**
 * A4 回归：可重建交付
 *
 * 覆盖验收报告指出的问题——仓库缺少迁移 SQL 与依赖锁，导致干净检出无法重建；
 * 且不能通过"重新生成迁移"覆盖历史。
 *
 * 这里对**测试库**做真实验证：
 *   1. 空库从零迁移 → 必需表齐全、迁移记录写入；
 *   2. 重复迁移幂等 → 不报错、不重复应用；
 *   3. **遗留库升级**：先真实执行 0000→0002 并写入数据，再执行 0003，
 *      验证 admin_users → users 的重命名迁移不丢数据、且把既有账号提升为管理员；
 *   4. 迁移目录中不含空文件，历史迁移文件名稳定。
 *
 * 第 3 条是本文件最重要的用例：drizzle-kit 为"表改名"默认生成的是
 * `CREATE TABLE users` + `DROP TABLE admin_users CASCADE`，直接上线会删除
 * 唯一账号并级联清空会话。这里用真实的旧结构数据把它钉死。
 *
 * 注意：本文件会 DROP SCHEMA，因此测试必须串行执行（run.ts 已设 --test-concurrency=1）。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import { sql, type SQL } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { requireTestDatabase } from '../helpers/guard';

requireTestDatabase();

const { db, pool } = await import('../../src/server/db/client');

const REQUIRED_TABLES = [
  'audit_logs',
  'csv_import_batches',
  'events',
  'expected_bills',
  'notification_attempts',
  'notification_jobs',
  'notification_rules',
  'payments',
  'sessions',
  'settings',
  'subscription_price_history',
  'subscriptions',
  'tasks',
  'users',
  'wechat_accounts',
  'wechat_inbox',
  'wechat_operations',
  'wechat_outbox',
];

/** 归属表：多用户隔离的基石，必须每张都有 NOT NULL 的 user_id */
const OWNED_TABLES = [
  'csv_import_batches',
  'events',
  'expected_bills',
  'notification_attempts',
  'notification_jobs',
  'notification_rules',
  'payments',
  'subscription_price_history',
  'subscriptions',
  'tasks',
  'wechat_inbox',
  'wechat_operations',
  'wechat_outbox',
];

async function tableNames(): Promise<string[]> {
  const result = (await db.execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name
  `)) as unknown as { rows: { table_name: string }[] };
  return result.rows.map((r) => r.table_name);
}

async function migrationCount(): Promise<number> {
  const result = (await db.execute(
    sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
  )) as unknown as { rows: { n: number }[] };
  return result.rows[0]?.n ?? 0;
}

async function scalar(query: SQL): Promise<unknown> {
  const result = (await db.execute(query)) as unknown as { rows: Record<string, unknown>[] };
  const row = result.rows[0];
  return row ? Object.values(row)[0] : undefined;
}

async function dropEverything(): Promise<void> {
  await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);
}

/** 直接执行迁移 SQL 文件（`--> statement-breakpoint` 本身就是 SQL 注释，可整段切分） */
async function applySqlFile(path: string): Promise<void> {
  const content = readFileSync(path, 'utf8');
  for (const statement of content.split('--> statement-breakpoint')) {
    if (statement.trim().length === 0) continue;
    await db.execute(sql.raw(statement));
  }
}

describe('A4 迁移可重建性', () => {
  it('空库从零迁移后，必需表齐全且迁移记录已写入', async () => {
    await dropEverything();
    assert.deepEqual(await tableNames(), [], '前置条件：schema 应为空');

    await migrate(db, { migrationsFolder: 'drizzle' });

    const tables = await tableNames();
    for (const required of REQUIRED_TABLES) {
      assert.ok(tables.includes(required), `缺少必需表 ${required}`);
    }
    assert.ok(!tables.includes('admin_users'), '管理员表应已被重命名为 users');
    assert.ok((await migrationCount()) >= 5, '5 个迁移都应记录在案');

    // 多用户改造后的结构断言
    for (const column of ['is_admin', 'disabled_at', 'must_change_password', 'password_changed_at']) {
      const found = await scalar(sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = ${column}
      `);
      assert.equal(found, 1, `users.${column} 应随迁移创建`);
    }

    // 隔离的基石：13 张归属表都必须有 NOT NULL 的 user_id
    for (const table of OWNED_TABLES) {
      const owned = await scalar(sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_name = ${table} AND column_name = 'user_id' AND is_nullable = 'NO'
      `);
      assert.equal(owned, 1, `${table}.user_id 必须存在且为 NOT NULL`);
    }

    // 复合外键的引用目标唯一索引必须存在（否则迁移本身就建不起来）
    for (const idx of [
      'subscriptions_id_user_uq',
      'expected_bills_id_user_uq',
      'notification_jobs_id_user_uq',
      'notification_rules_id_user_uq',
    ]) {
      const found = await scalar(sql`SELECT 1 FROM pg_indexes WHERE indexname = ${idx}`);
      assert.equal(found, 1, `复合外键的引用目标 ${idx} 应存在`);
    }

    const singleton = await scalar(sql`
      SELECT 1 FROM pg_indexes WHERE indexname = 'admin_users_singleton_uq'
    `);
    assert.equal(singleton, undefined, '单管理员唯一索引必须已被删除（否则无法创建第二个账号）');

    const fk = await scalar(sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'notification_jobs' AND column_name = 'failure_kind'
    `);
    assert.equal(fk, 1, 'failure_kind 列应随迁移创建');
  });

  it('重复执行迁移是幂等的：不报错、迁移记录数不变', async () => {
    await migrate(db, { migrationsFolder: 'drizzle' });
    const before = await migrationCount();

    await migrate(db, { migrationsFolder: 'drizzle' });
    await migrate(db, { migrationsFolder: 'drizzle' });

    assert.equal(await migrationCount(), before, '重复迁移不应重复应用');
  });

  it('遗留库升级：既有数据全部保留并正确回填归属，旧全局微信绑定搬到 wechat_accounts', async () => {
    await dropEverything();

    // 1) 真实重建多用户改造**之前**的库结构（不经过 drizzle 记账，纯 SQL）
    for (const file of ['0000_init.sql', '0001_singleton_admin_and_failure_kind.sql', '0002_dizzy_banshee.sql']) {
      await applySqlFile(`drizzle/${file}`);
    }
    assert.ok((await tableNames()).includes('admin_users'), '前置条件：旧库应存在 admin_users');
    assert.ok(!(await tableNames()).includes('users'), '前置条件：旧库不应存在 users');

    // 2) 写入覆盖各业务表的遗留数据（模拟真实生产库的样子）
    await db.execute(sql`
      INSERT INTO admin_users (username, password_hash) VALUES ('legacy-admin', 'legacy-hash')
    `);
    await db.execute(sql`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      SELECT id, 'legacy-session-token', now() + interval '1 day' FROM admin_users WHERE username = 'legacy-admin'
    `);
    await db.execute(sql`
      INSERT INTO audit_logs (user_id, action)
      SELECT id, 'legacy.action' FROM admin_users WHERE username = 'legacy-admin'
    `);
    await db.execute(sql`INSERT INTO events (title, start_at) VALUES ('遗留事件', now())`);
    await db.execute(sql`INSERT INTO tasks (title, due_date) VALUES ('遗留待办', current_date)`);
    await db.execute(sql`
      INSERT INTO subscriptions (name, price, currency, anchor_date) VALUES ('遗留订阅', 20.00, 'CNY', current_date)
    `);
    await db.execute(sql`
      INSERT INTO expected_bills (subscription_id, planned_date, amount, currency)
      SELECT id, current_date + 30, 20.00, 'CNY' FROM subscriptions
    `);
    await db.execute(sql`
      INSERT INTO payments (subscription_id, paid_at, amount, currency)
      SELECT id, current_date, 20.00, 'CNY' FROM subscriptions
    `);
    await db.execute(sql`
      INSERT INTO notification_rules (subject_type, subject_id, channel, enabled, offsets_minutes)
      SELECT 'event', id, 'wechat', true, '[60]'::jsonb FROM events
    `);
    await db.execute(sql`
      INSERT INTO notification_jobs (rule_id, subject_type, subject_id, title, body, fire_at, idempotency_key)
      SELECT r.id, 'event', r.subject_id, '遗留提醒', '正文', now(), 'legacy-job-key'
      FROM notification_rules r WHERE r.subject_type = 'event'
    `);
    await db.execute(sql`
      INSERT INTO notification_attempts (job_id, success) SELECT id, false FROM notification_jobs
    `);
    await db.execute(sql`
      INSERT INTO wechat_inbox (binding_generation, provider_message_id, from_user_id, text, parse_basis_at)
      VALUES (gen_random_uuid(), 'legacy-msg', 'wx-user', '明天开会', now())
    `);
    // 改造前的全局微信绑定（密文原样，迁移不得改动它）
    await db.execute(sql`
      INSERT INTO settings (key, value) VALUES ('wechat.private-channel', jsonb_build_object(
        'account', 'FAKE.SEALED.CREDENTIAL', 'context', 'FAKE.SEALED.CONTEXT', 'cursor', 'cursor-abc',
        'generation', '11111111-1111-1111-1111-111111111111',
        'revision', '22222222-2222-2222-2222-222222222222',
        'boundAt', 1791776414337, 'used', 3, 'warned', true))
    `);

    // 3) 执行两步迁移：改名 → 数据隔离
    await applySqlFile('drizzle/0003_multi_user.sql');
    await applySqlFile('drizzle/0004_multi_user_isolation.sql');

    // 4) 断言：表结构与归属关系
    const tables = await tableNames();
    assert.ok(tables.includes('users'), '应存在 users 表');
    assert.ok(!tables.includes('admin_users'), 'admin_users 应已不存在');
    assert.ok(tables.includes('wechat_accounts'), '应存在 wechat_accounts 表');

    const legacy = (await db.execute(sql`
      SELECT id, username, password_hash, is_admin, must_change_password, disabled_at
      FROM users WHERE username = 'legacy-admin'
    `)) as unknown as {
      rows: { id: number; password_hash: string; is_admin: boolean; must_change_password: boolean; disabled_at: Date | null }[];
    };
    assert.equal(legacy.rows.length, 1, '遗留账号必须完整保留，绝不能被 DROP 掉');
    const legacyId = legacy.rows[0]!.id;
    assert.equal(legacy.rows[0]!.password_hash, 'legacy-hash', '密码哈希不得被改写');
    assert.equal(legacy.rows[0]!.is_admin, true, '改造前的唯一账号就是管理员，必须提升');
    assert.equal(legacy.rows[0]!.must_change_password, false, '不得给既有账号强加改密要求');
    assert.equal(legacy.rows[0]!.disabled_at, null, '不得把既有账号置为禁用');

    const sessions = await scalar(sql`SELECT count(*)::int FROM sessions WHERE token_hash = 'legacy-session-token'`);
    assert.equal(sessions, 1, '会话必须保留（改名的默认 drizzle 输出会 CASCADE 清空它）');

    const linked = await scalar(sql`
      SELECT count(*)::int FROM audit_logs a JOIN users u ON u.id = a.user_id WHERE a.action = 'legacy.action'
    `);
    assert.equal(linked, 1, '审计记录必须仍然指向同一个账号');

    // 每张业务表的行都还在，且归属都被回填到既有账号（而不是留 NULL 或被丢弃）
    const owned: [string, string][] = [
      ['events', "title = '遗留事件'"],
      ['tasks', "title = '遗留待办'"],
      ['subscriptions', "name = '遗留订阅'"],
      ['expected_bills', 'true'],
      ['payments', 'true'],
      ['notification_rules', "subject_type = 'event'"],
      ['notification_jobs', "idempotency_key = 'legacy-job-key'"],
      ['wechat_inbox', "provider_message_id = 'legacy-msg'"],
    ];
    for (const [table, condition] of owned) {
      const total = await scalar(sql.raw(`SELECT count(*)::int FROM ${table} WHERE ${condition}`));
      assert.equal(total, 1, `${table} 的遗留数据必须保留`);
      const orphan = await scalar(
        sql.raw(`SELECT count(*)::int FROM ${table} WHERE ${condition} AND user_id <> ${legacyId}`),
      );
      assert.equal(orphan, 0, `${table} 的遗留数据必须归属既有账号`);
    }
    const attemptsLinked = await scalar(sql`
      SELECT count(*)::int FROM notification_attempts a
      JOIN notification_jobs j ON j.id = a.job_id WHERE j.user_id = a.user_id
    `);
    assert.equal(attemptsLinked, 1, '发送尝试必须与所属任务同属一个账号');

    // 5) 旧全局微信绑定：密文原样搬入 wechat_accounts，旧 settings 行删除
    const account = (await db.execute(sql`
      SELECT user_id, generation, revision, account_enc, context_enc, cursor, used, warned
      FROM wechat_accounts
    `)) as unknown as {
      rows: { user_id: number; account_enc: string; context_enc: string; cursor: string; used: number; warned: boolean }[];
    };
    assert.equal(account.rows.length, 1, '应恰好搬入一份微信绑定');
    assert.equal(account.rows[0]!.user_id, legacyId, '绑定必须归既有账号');
    assert.equal(account.rows[0]!.account_enc, 'FAKE.SEALED.CREDENTIAL', '密文必须原样搬运（SQL 迁移无法重新加密）');
    assert.equal(account.rows[0]!.context_enc, 'FAKE.SEALED.CONTEXT');
    assert.equal(account.rows[0]!.cursor, 'cursor-abc', '接收游标必须保留，否则会重放旧消息');
    assert.equal(account.rows[0]!.used, 3, '发送窗口计数必须保留（否则会凭空多出额度）');
    assert.equal(account.rows[0]!.warned, true);
    const legacyState = await scalar(sql`SELECT count(*)::int FROM settings WHERE key = 'wechat.private-channel'`);
    assert.equal(legacyState, 0, '旧 settings 行必须删除，避免同一份凭据在两处各留一份');

    // 6) 复合外键：跨账号错配必须被数据库拒绝
    await db.execute(sql`INSERT INTO users (username, password_hash) VALUES ('second', 'x')`);
    const secondId = (await scalar(sql`SELECT id FROM users WHERE username = 'second'`)) as number;
    assert.notEqual(secondId, legacyId);

    await assert.rejects(
      async () => {
        await db.execute(sql`
          INSERT INTO expected_bills (subscription_id, user_id, planned_date, amount, currency)
          SELECT id, ${secondId}, current_date + 99, 1.00, 'CNY' FROM subscriptions LIMIT 1
        `);
      },
      /foreign key|violates/i,
      '账单归属与订阅归属不一致时必须被数据库拒绝（这是隔离的基石）',
    );

    // 7) 迁移后仍然可以并存第二个账号
    const total = await scalar(sql`SELECT count(*)::int FROM users`);
    assert.equal(total, 2, '多账号必须能在数据库层并存');
  });

  it('迁移目录中不含空文件，且历史迁移未被重新生成（文件名与顺序稳定）', async () => {
    const files = readdirSync('drizzle')
      .filter((f) => f.endsWith('.sql'))
      .sort();
    assert.ok(files.length >= 5, '至少应有 init 与后续修复迁移');
    assert.equal(files[0], '0000_init.sql', '历史迁移文件名必须稳定，不得被重新生成覆盖');

    for (const f of files) {
      const content = readFileSync(`drizzle/${f}`, 'utf8');
      assert.ok(content.trim().length > 0, `迁移文件 ${f} 不应为空`);
    }
  });
});

// 本文件的用例会 DROP SCHEMA（包括 drizzle 记账表）。必须在收尾时恢复到
// "结构完整 + 记账一致"的状态，否则：
//   - 后续测试文件面对的是"表都在、记账为空"的库；
//   - run.ts 收尾调用 migrate() 时会认为一条都没应用，重新执行 0000 并以
//     "table already exists" 失败。
// 关闭连接池前先恢复，顺序不能调换。
after(async () => {
  await dropEverything();
  await migrate(db, { migrationsFolder: 'drizzle' });
  await pool.end();
});

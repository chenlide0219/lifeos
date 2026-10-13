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
    assert.ok((await migrationCount()) >= 4, '4 个迁移都应记录在案');

    // 多用户改造后的结构断言
    for (const column of ['is_admin', 'disabled_at', 'must_change_password', 'password_changed_at']) {
      const found = await scalar(sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = ${column}
      `);
      assert.equal(found, 1, `users.${column} 应随迁移创建`);
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

  it('遗留库升级：admin_users 上的数据在重命名后完整保留，且既有账号成为管理员', async () => {
    await dropEverything();

    // 1) 真实重建多用户改造**之前**的库结构（不经过 drizzle 记账，纯 SQL）
    for (const file of ['0000_init.sql', '0001_singleton_admin_and_failure_kind.sql', '0002_dizzy_banshee.sql']) {
      await applySqlFile(`drizzle/${file}`);
    }
    assert.ok((await tableNames()).includes('admin_users'), '前置条件：旧库应存在 admin_users');
    assert.ok(!(await tableNames()).includes('users'), '前置条件：旧库不应存在 users');

    // 2) 写入遗留数据：1 个管理员 + 它的会话 + 审计 + 一条业务数据
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
    await db.execute(sql`
      INSERT INTO events (title, start_at) VALUES ('遗留事件', now())
    `);

    // 3) 执行改名迁移
    await applySqlFile('drizzle/0003_multi_user.sql');

    // 4) 断言：表已改名、行与归属关系一点没丢、既有账号被提升为管理员
    const tables = await tableNames();
    assert.ok(tables.includes('users'), '应存在 users 表');
    assert.ok(!tables.includes('admin_users'), 'admin_users 应已不存在');

    const legacy = (await db.execute(sql`
      SELECT id, username, password_hash, is_admin, must_change_password, disabled_at
      FROM users WHERE username = 'legacy-admin'
    `)) as unknown as {
      rows: { id: number; password_hash: string; is_admin: boolean; must_change_password: boolean; disabled_at: Date | null }[];
    };
    assert.equal(legacy.rows.length, 1, '遗留账号必须完整保留，绝不能被 DROP 掉');
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

    const events = await scalar(sql`SELECT count(*)::int FROM events WHERE title = '遗留事件'`);
    assert.equal(events, 1, '业务数据不得受影响');

    // 5) 迁移后仍然可以并存第二个账号
    await db.execute(sql`INSERT INTO users (username, password_hash) VALUES ('second', 'x')`);
    const total = await scalar(sql`SELECT count(*)::int FROM users`);
    assert.equal(total, 2, '多账号必须能在数据库层并存');
  });

  it('迁移目录中不含空文件，且历史迁移未被重新生成（文件名与顺序稳定）', async () => {
    const files = readdirSync('drizzle')
      .filter((f) => f.endsWith('.sql'))
      .sort();
    assert.ok(files.length >= 4, '至少应有 init 与后续修复迁移');
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

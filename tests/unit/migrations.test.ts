/**
 * A4 回归：可重建交付
 *
 * 覆盖验收报告指出的问题——仓库缺少迁移 SQL 与依赖锁，
 * 导致干净检出无法重建；且不能通过"重新生成迁移"覆盖历史。
 *
 * 这里对**测试库**做真实验证：
 *   1. 空库从零迁移 → 14 张表齐全、迁移记录写入；
 *   2. 重复迁移幂等 → 不报错、不重复应用；
 *   3. 既有库升级保留数据 → 先写入业务数据再迁移，数据仍在。
 *
 * 注意：本文件会 DROP SCHEMA，因此测试必须串行执行（run.ts 已设 --test-concurrency=1）。
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { requireTestDatabase } from '../helpers/guard';

requireTestDatabase();

const { db, pool } = await import('../../src/server/db/client');

const REQUIRED_TABLES = [
  'admin_users',
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

async function dropEverything(): Promise<void> {
  await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);
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
    assert.ok((await migrationCount()) >= 2, '两次迁移（init + singleton/failure_kind）都应记录在案');

    // 新增的两项修复确实随迁移落地
    const singleton = (await db.execute(sql`
      SELECT 1 AS ok FROM pg_indexes WHERE indexname = 'admin_users_singleton_uq'
    `)) as unknown as { rows: unknown[] };
    assert.equal(singleton.rows.length, 1, '单管理员唯一索引应随迁移创建');

    const col = (await db.execute(sql`
      SELECT 1 AS ok FROM information_schema.columns
      WHERE table_name = 'notification_jobs' AND column_name = 'failure_kind'
    `)) as unknown as { rows: unknown[] };
    assert.equal(col.rows.length, 1, 'failure_kind 列应随迁移创建');
  });

  it('重复执行迁移是幂等的：不报错、迁移记录数不变', async () => {
    await migrate(db, { migrationsFolder: 'drizzle' });
    const before = await migrationCount();

    await migrate(db, { migrationsFolder: 'drizzle' });
    await migrate(db, { migrationsFolder: 'drizzle' });

    assert.equal(await migrationCount(), before, '重复迁移不应重复应用');
  });

  it('既有库升级保留数据：写入数据后再迁移，数据仍在', async () => {
    await db.execute(sql`
      INSERT INTO admin_users (username, password_hash) VALUES ('migration-probe', 'x')
    `);
    await db.execute(sql`
      INSERT INTO settings (key, value) VALUES ('migration.probe', '{"v":1}'::jsonb)
      ON CONFLICT (key) DO NOTHING
    `);

    await migrate(db, { migrationsFolder: 'drizzle' });

    const admins = (await db.execute(
      sql`SELECT username FROM admin_users WHERE username = 'migration-probe'`,
    )) as unknown as { rows: { username: string }[] };
    assert.equal(admins.rows.length, 1, '迁移不得丢失既有数据');

    const setting = (await db.execute(
      sql`SELECT value FROM settings WHERE key = 'migration.probe'`,
    )) as unknown as { rows: { value: unknown }[] };
    assert.equal(setting.rows.length, 1, '迁移不得丢失既有设置');

    await db.execute(sql`DELETE FROM admin_users WHERE username = 'migration-probe'`);
    await db.execute(sql`DELETE FROM settings WHERE key = 'migration.probe'`);
  });

  it('迁移目录中不含空文件，且历史迁移未被重新生成（文件名与顺序稳定）', async () => {
    const { readdirSync } = await import('node:fs');
    const files = readdirSync('drizzle')
      .filter((f) => f.endsWith('.sql'))
      .sort();
    assert.ok(files.length >= 2, '至少应有 init 与后续修复两个迁移');
    assert.equal(files[0], '0000_init.sql', '历史迁移文件名必须稳定，不得被重新生成覆盖');

    const { readFileSync } = await import('node:fs');
    for (const f of files) {
      const content = readFileSync(`drizzle/${f}`, 'utf8');
      assert.ok(content.trim().length > 0, `迁移文件 ${f} 不应为空`);
    }
  });
});

// 关闭连接池，避免测试进程因句柄未释放而挂住
after(async () => {
  await pool.end();
});

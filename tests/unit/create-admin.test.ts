/**
 * A6 回归：单管理员不变量
 *
 * 覆盖验收报告指出的问题——按"换用户名"执行初始化会创建第二个管理员，
 * 既不是重命名，也不安全。
 *
 * 两层保障都测：
 *   1. CLI 语义：已有管理员时拒绝新增，更名走 UPDATE 现有唯一账户；
 *   2. 数据库层：常量表达式唯一索引使任何路径都无法插入第二行。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, beforeEach, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { requireTestDatabase } from '../helpers/guard';

const TEST_URL = requireTestDatabase();

const { db, pool } = await import('../../src/server/db/client');

const STRONG = 'Test-Password-123!@#';

function runCli(args: string[]): { status: number; output: string } {
  const result = spawnSync('npx', ['tsx', 'src/scripts/create-admin.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: TEST_URL },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

async function adminRows(): Promise<{ id: number; username: string }[]> {
  const result = (await db.execute(
    sql`SELECT id, username FROM admin_users ORDER BY id`,
  )) as unknown as { rows: { id: number; username: string }[] };
  return result.rows;
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE admin_users, sessions, audit_logs RESTART IDENTITY CASCADE`);
});

after(async () => {
  await pool.end();
});

describe('A6 单管理员不变量', () => {
  it('首次初始化创建唯一管理员', async () => {
    const result = runCli(['alice', STRONG]);
    assert.equal(result.status, 0, `应成功，实际输出：${result.output}`);

    const rows = await adminRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.username, 'alice');
  });

  it('已有管理员时用另一个用户名 → 必须失败，且不产生第二个管理员（原缺陷）', async () => {
    assert.equal(runCli(['alice', STRONG]).status, 0);

    const result = runCli(['bob', STRONG]);
    assert.notEqual(result.status, 0, '换用户名初始化必须被拒绝');
    assert.match(result.output, /已存在管理员|不会创建第二个管理员/);

    const rows = await adminRows();
    assert.equal(rows.length, 1, '管理员数量必须仍为 1');
    assert.equal(rows[0]!.username, 'alice', '原管理员不得被改动');
  });

  it('已有管理员时不带任何标志的同名调用 → 也必须失败（不允许静默重置）', async () => {
    assert.equal(runCli(['alice', STRONG]).status, 0);

    const result = runCli(['alice', STRONG]);
    assert.notEqual(result.status, 0);
    assert.equal((await adminRows()).length, 1);
  });

  it('--update 且用户名匹配 → 重置密码，管理员数量仍为 1 且用户名不变', async () => {
    assert.equal(runCli(['alice', STRONG]).status, 0);

    const result = runCli(['alice', 'Another-Password-456!@#', '--update']);
    assert.equal(result.status, 0, `应成功，实际输出：${result.output}`);

    const rows = await adminRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.username, 'alice');
  });

  it('--update 但用户名不匹配 → 失败，且不新增账号', async () => {
    assert.equal(runCli(['alice', STRONG]).status, 0);

    const result = runCli(['bob', STRONG, '--update']);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /不一致|--rename/);

    const rows = await adminRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.username, 'alice');
  });

  it('--rename 是更新唯一账户而不是新增，并撤销全部旧会话', async () => {
    assert.equal(runCli(['alice', STRONG]).status, 0);
    const [before] = await adminRows();

    // 制造一个现存会话，验证更名后会被撤销
    await db.execute(sql`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${before!.id}, 'probe-token-hash', now() + interval '1 day')
    `);
    const sessionCount = async (): Promise<number> => {
      const r = (await db.execute(sql`SELECT count(*)::int AS n FROM sessions`)) as unknown as {
        rows: { n: number }[];
      };
      return r.rows[0]?.n ?? -1;
    };
    assert.equal(await sessionCount(), 1);

    const result = runCli(['carol', '--rename']);
    assert.equal(result.status, 0, `应成功，实际输出：${result.output}`);

    const rows = await adminRows();
    assert.equal(rows.length, 1, '更名不得新增账号');
    assert.equal(rows[0]!.username, 'carol');
    assert.equal(rows[0]!.id, before!.id, '必须是同一个账户被更新，而不是换了个人');
    assert.equal(await sessionCount(), 0, '更名后旧会话必须全部失效');
  });

  it('--rename 传密码属于用法错误（避免密码被静默忽略）', () => {
    assert.equal(runCli(['alice', STRONG]).status, 0);
    const result = runCli(['carol', STRONG, '--rename']);
    assert.equal(result.status, 2);
    assert.match(result.output, /只改用户名/);
  });

  it('--update 与 --rename 同时使用属于用法错误', () => {
    const result = runCli(['alice', STRONG, '--update', '--rename']);
    assert.equal(result.status, 2);
    assert.match(result.output, /不能同时使用/);
  });

  it('弱密码被拒绝，且不创建账号', async () => {
    const result = runCli(['alice', 'short']);
    assert.notEqual(result.status, 0);
    assert.equal((result.output.match(/至少需要 12 个字符|三类/) ?? []).length > 0, true);
    assert.equal((await adminRows()).length, 0);
  });

  it('数据库层唯一索引：直接插入第二个管理员被拒绝', async () => {
    assert.equal(runCli(['alice', STRONG]).status, 0);

    await assert.rejects(
      async () => {
        await db.execute(sql`
          INSERT INTO admin_users (username, password_hash) VALUES ('mallory', 'x')
        `);
      },
      /duplicate key|unique|admin_users_singleton_uq/i,
      '绕过 CLI 直接写库也必须被数据库拒绝',
    );

    assert.equal((await adminRows()).length, 1);
  });
});

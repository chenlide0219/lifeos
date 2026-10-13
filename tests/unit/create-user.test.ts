/**
 * 账号管理回归（取代原 A6「单管理员不变量」）。
 *
 * 被取代的原因：多用户上线后"库里只能有一个账号"不再是产品不变量，
 * 原有的两处断言（CLI 拒绝第二个账号、数据库常量唯一索引）已随迁移 0003 解除。
 * 但**不开放注册**没有变，因此这里改为断言新的一组不变量：
 *
 *   1. 账号只能由 CLI / 管理界面创建，且新建账号默认**不是**管理员；
 *   2. 第一个账号自动成为管理员——否则空库上没有人能再管理账号；
 *   3. 任何由管理员设置的初始密码（含弱口令）都强制首次登录改密；
 *   4. 改密/更名/禁用都会立刻撤销该账号的全部会话。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, beforeEach, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { requireTestDatabase } from '../helpers/guard';

const TEST_URL = requireTestDatabase();

const { db, pool } = await import('../../src/server/db/client');

const STRONG = 'Test-Password-123!@#';

function runCli(args: string[], stdin?: string): { status: number; output: string } {
  // 用 node 直接跑 tsx 加载器：spawnSync('npx') 在 Windows 上找不到 .cmd 垫片
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/scripts/create-user.ts', ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: TEST_URL },
      encoding: 'utf8',
      timeout: 60_000,
      input: stdin,
    },
  );
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

type UserRow = {
  id: number;
  username: string;
  is_admin: boolean;
  must_change_password: boolean;
  disabled_at: Date | null;
};

async function userRows(): Promise<UserRow[]> {
  const result = (await db.execute(sql`
    SELECT id, username, is_admin, must_change_password, disabled_at FROM users ORDER BY id
  `)) as unknown as { rows: UserRow[] };
  return result.rows;
}

async function sessionCount(userId?: number): Promise<number> {
  const result = (await db.execute(
    userId === undefined
      ? sql`SELECT count(*)::int AS n FROM sessions`
      : sql`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${userId}`,
  )) as unknown as { rows: { n: number }[] };
  return result.rows[0]?.n ?? -1;
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE users, sessions, audit_logs RESTART IDENTITY CASCADE`);
});

after(async () => {
  await pool.end();
});

describe('账号管理（多用户）', () => {
  it('空库上的第一个账号自动成为管理员，避免把自己锁在门外', async () => {
    const result = runCli(['alice', STRONG]);
    assert.equal(result.status, 0, `应成功，实际输出：${result.output}`);

    const rows = await userRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.username, 'alice');
    assert.equal(rows[0]!.is_admin, true, '首个账号必须是管理员，否则无人能再管理账号');
  });

  it('第二个账号默认是普通用户；只有显式 --admin 才授予账号管理权限', async () => {
    assert.equal(runCli(['alice', STRONG]).status, 0);

    assert.equal(runCli(['bob', STRONG]).status, 0);
    assert.equal(runCli(['carol', STRONG, '--admin']).status, 0);

    const rows = await userRows();
    const byName = new Map(rows.map((r) => [r.username, r]));
    assert.equal(byName.get('bob')!.is_admin, false, '默认不得有管理权限');
    assert.equal(byName.get('carol')!.is_admin, true);
    assert.equal(rows.length, 3, '多用户可以并存');
  });

  it('同名重复创建被拒绝，且不新增账号、不改动原账号', async () => {
    assert.equal(runCli(['alice', STRONG]).status, 0);
    const before = (await userRows())[0]!;

    const result = runCli(['alice', 'Another-Password-456!@#']);
    assert.notEqual(result.status, 0, '同名创建必须失败');
    assert.match(result.output, /已存在/);

    const after = await userRows();
    assert.equal(after.length, 1);
    assert.equal(after[0]!.id, before.id, '原账号不得被替换');
  });

  it('弱初始密码只警告不拒绝，但一律强制首次登录改密（Wangliu66 场景）', async () => {
    // 先建一个管理员让库非空：否则首个账号会被"防止锁死"规则自动提升为管理员，
    // 就测不到普通用户这一面了（生产上 admin 已存在，Wangliu 不是首个账号）
    assert.equal(runCli(['admin', STRONG]).status, 0);

    const result = runCli(['Wangliu', 'Wangliu66']);
    assert.equal(result.status, 0, `弱初始密码应被接受（一次性凭据），实际输出：${result.output}`);
    assert.match(result.output, /不满足强度策略/, '必须明确警告，不能静默接受弱口令');

    const wangliu = (await userRows()).find((r) => r.username === 'Wangliu')!;
    assert.ok(wangliu, '账号应已创建');
    assert.equal(
      wangliu.must_change_password,
      true,
      '初始密码是一次性凭据：不改密前不得使用任何业务功能',
    );
    assert.equal(wangliu.is_admin, false, '不是首个账号时不得自动获得管理权限');
  });

  it('强初始密码同样要求首次改密（不能只有弱口令才强制）', async () => {
    assert.equal(runCli(['alice', STRONG]).status, 0);
    const rows = await userRows();
    assert.equal(rows[0]!.must_change_password, true);
    assert.equal((await userRows()).length, 1);
  });

  it('--password-stdin 从管道读取初始密码，避免出现在命令行与历史里', async () => {
    const result = runCli(['dave', '--password-stdin'], 'Pipe-Only-Password-9!\n');
    assert.equal(result.status, 0, `应成功，实际输出：${result.output}`);

    const rows = await userRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.username, 'dave');
    assert.equal(rows[0]!.must_change_password, true);
  });

  it('--update 重置密码：重新标记必须改密，并撤销该账号全部旧会话', async () => {
    assert.equal(runCli(['alice', STRONG]).status, 0);
    const [alice] = await userRows();

    // 先模拟"用户已经改过密、且有活跃会话"
    await db.execute(sql`
      UPDATE users SET must_change_password = false WHERE id = ${alice!.id}
    `);
    await db.execute(sql`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${alice!.id}, 'probe-token-hash', now() + interval '1 day')
    `);
    assert.equal(await sessionCount(alice!.id), 1);

    const result = runCli(['alice', 'Another-Password-456!@#', '--update']);
    assert.equal(result.status, 0, `应成功，实际输出：${result.output}`);

    const rows = await userRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, alice!.id, '重置密码不得新建账号');
    assert.equal(rows[0]!.must_change_password, true, '重置后必须重新改密');
    assert.equal(await sessionCount(alice!.id), 0, '重置后旧会话必须全部失效');
  });

  it('--update 对不存在的账号失败，且不新增账号', async () => {
    assert.equal(runCli(['alice', STRONG]).status, 0);

    const result = runCli(['bob', STRONG, '--update']);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /不存在/);

    const rows = await userRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.username, 'alice');
  });

  it('--rename 更新同一账号（id 不变）而不是新增，并撤销全部旧会话', async () => {
    assert.equal(runCli(['alice', STRONG]).status, 0);
    const [before] = await userRows();

    await db.execute(sql`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${before!.id}, 'probe-token-hash', now() + interval '1 day')
    `);
    assert.equal(await sessionCount(), 1);

    const usage = runCli(['alice', '--rename', 'carol', 'Some-Password-123!']);
    assert.equal(usage.status, 2, '--rename 不接受密码参数');
    assert.match(usage.output, /只改用户名/);
    assert.equal(await sessionCount(), 1, '用法错误不得产生任何修改');

    const ok = runCli(['alice', '--rename', 'carol']);
    assert.equal(ok.status, 0, `应成功，实际输出：${ok.output}`);
    assert.match(ok.output, /已将账号 alice 重命名为 carol/);

    const rows = await userRows();
    assert.equal(rows.length, 1, '更名不得新增账号');
    assert.equal(rows[0]!.username, 'carol');
    assert.equal(rows[0]!.id, before!.id, '必须是同一个账号被更新，而不是换了个人');
    assert.equal(await sessionCount(), 0, '更名后旧会话必须全部失效');
  });

  it('--disable 禁用账号并撤销其会话；--enable 恢复', async () => {
    assert.equal(runCli(['alice', STRONG]).status, 0);
    assert.equal(runCli(['bob', STRONG]).status, 0);
    const rows0 = await userRows();
    const bob = rows0.find((r) => r.username === 'bob')!;

    await db.execute(sql`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${bob.id}, 'probe-token-hash', now() + interval '1 day')
    `);

    const disabled = runCli(['bob', '--disable']);
    assert.equal(disabled.status, 0, `应成功，实际输出：${disabled.output}`);

    const afterDisable = (await userRows()).find((r) => r.username === 'bob')!;
    assert.notEqual(afterDisable.disabled_at, null, '必须真正写入禁用时间');
    assert.equal(await sessionCount(bob.id), 0, '禁用必须立刻撤销其全部会话');

    const enabled = runCli(['bob', '--enable']);
    assert.equal(enabled.status, 0, `应成功，实际输出：${enabled.output}`);
    const afterEnable = (await userRows()).find((r) => r.username === 'bob')!;
    assert.equal(afterEnable.disabled_at, null);
  });

  it('不能禁用唯一启用中的管理员（否则将无人能管理账号）', async () => {
    assert.equal(runCli(['alice', STRONG]).status, 0);

    const result = runCli(['alice', '--disable']);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /唯一启用中的管理员/);

    const rows = await userRows();
    assert.equal(rows[0]!.disabled_at, null, '失败时不得留下部分修改');
  });

  it('有第二个管理员时，禁用其中一个是被允许的', async () => {
    assert.equal(runCli(['alice', STRONG]).status, 0);
    assert.equal(runCli(['carol', STRONG, '--admin']).status, 0);

    const result = runCli(['alice', '--disable']);
    assert.equal(result.status, 0, `应成功，实际输出：${result.output}`);
    assert.notEqual((await userRows()).find((r) => r.username === 'alice')!.disabled_at, null);
  });

  it('--list 列出账号及其权限与状态', async () => {
    assert.equal(runCli(['alice', STRONG]).status, 0);
    assert.equal(runCli(['Wangliu', 'Wangliu66']).status, 0);

    const result = runCli(['--list']);
    assert.equal(result.status, 0);
    assert.match(result.output, /共 2 个账号/);
    assert.match(result.output, /alice/);
    assert.match(result.output, /Wangliu/);
    assert.match(result.output, /管理员/);
    assert.match(result.output, /普通用户/);
    assert.match(result.output, /待改密/);
  });

  it('用法错误以退出码 2 结束，与执行失败（1）区分开', () => {
    assert.equal(runCli(['alice', STRONG, '--update', '--rename']).status, 2);
    assert.equal(runCli(['alice', STRONG, '--disable', '--list']).status, 2);
    assert.equal(runCli(['alice', '--rename']).status, 2);
    assert.equal(runCli(['a', STRONG]).status, 2, '用户名过短属于用法错误');
  });

  it('单管理员约束已解除：直接写库可以插入第二个账号（与旧不变量相反）', async () => {
    assert.equal(runCli(['alice', STRONG]).status, 0);

    // 旧的 admin_users_singleton_uq 会把这一行拒掉；迁移 0003 之后必须能插入。
    await db.execute(sql`
      INSERT INTO users (username, password_hash) VALUES ('mallory', 'x')
    `);

    assert.equal((await userRows()).length, 2, '多账号必须能在数据库层并存');
  });
});

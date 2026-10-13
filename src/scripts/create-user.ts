/**
 * 账号初始化与维护（多用户版，取代原 create-admin）。
 *
 * 产品约束没有变：**不开放注册**，账号只能由本命令或管理界面显式创建。
 * 变的是不再有"系统只能有一个账号"的不变量——但数据库里也没有任何
 * "默认权限"，新建账号默认 `is_admin = false`。
 *
 * 用法：
 *   npm run create-user -- --list
 *   npm run create-user -- <用户名> [初始密码] [--admin]
 *   npm run create-user -- <用户名> --password-stdin [--admin]
 *   npm run create-user -- <用户名> --update [新密码]
 *   npm run create-user -- <用户名> --rename <新用户名>
 *   npm run create-user -- <用户名> --disable
 *   npm run create-user -- <用户名> --enable
 *
 * 初始密码的三条规则：
 *   1. 不满足强度策略（≥12 位、≥3 类字符）时**只警告不拒绝**——它是一次性凭据，
 *      用户首次登录必须改密，而管理员经常需要设置一个便于当面告知的短密码；
 *   2. 无论强弱，一律置 `must_change_password = true`：改密前后端会拒绝所有业务接口；
 *   3. 只在终端打印一次，不写日志、不入库明文。
 *
 * 密码不要放在命令行上：`ps` 与 shell 历史都会留下它。
 * 优先用 `--password-stdin`（从管道读第一行）。
 */
import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../server/db/client';
import { auditLogs, sessions, users } from '../server/db/schema';
import { checkPasswordStrength, generateStrongPassword, hashPassword } from '../server/lib/password';

type UserRow = { id: number; username: string; is_admin: boolean; disabled_at: Date | null };

type Mode = 'create' | 'update' | 'rename' | 'disable' | 'enable' | 'list';

/**
 * 用法错误与执行失败分开：用法错误退出码 2，执行失败退出码 1。
 * 脚本化调用时能据此区分"我把命令写错了"与"库里的状态不允许"。
 */
class UsageError extends Error {}

const USAGE = `用法:
  npm run create-user -- --list
  npm run create-user -- <用户名> [初始密码] [--admin]
  npm run create-user -- <用户名> --password-stdin [--admin]
  npm run create-user -- <用户名> --update [新密码]
  npm run create-user -- <用户名> --rename <新用户名>
  npm run create-user -- <用户名> --disable
  npm run create-user -- <用户名> --enable

说明:
  --admin            授予账号管理权限（新建账号默认没有）
  --password-stdin   从标准输入读第一行作为初始密码，避免出现在命令行与历史里
  --update           重置密码，并强制该用户下次登录改密，同时注销其全部会话
  库中还没有任何账号时，第一个账号自动成为管理员（避免把自己锁在门外）。`;

// 密码生成统一走 lib（与设置页的"新增账号/重置密码"共用同一实现）
const generatePassword = generateStrongPassword;

async function readPasswordFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8').split('\n')[0]!.trim();
}

function assertValidUsername(username: string): void {
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
    throw new UsageError('用户名只能包含字母、数字、下划线、点、连字符，长度 3-64');
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const has = (flag: string) => argv.includes(flag);
  const positionals = argv.filter((a) => !a.startsWith('--'));

  if (argv.length === 0 || has('--help') || has('-h')) {
    console.log(USAGE);
    return;
  }

  const selected: Mode[] = [];
  if (has('--update')) selected.push('update');
  if (has('--rename')) selected.push('rename');
  if (has('--disable')) selected.push('disable');
  if (has('--enable')) selected.push('enable');
  if (has('--list')) selected.push('list');
  if (selected.length > 1) throw new UsageError(`这些参数只能用一个：${selected.map((m) => `--${m}`).join(' / ')}`);
  const mode: Mode = selected[0] ?? 'create';

  const wantsAdmin = has('--admin');
  const passwordFromStdin = has('--password-stdin');

  // ── 只读：列出账号 ──
  if (mode === 'list') {
    const rows = (await db.execute(sql`
      SELECT u.id, u.username, u.is_admin, u.disabled_at,
             u.must_change_password, u.created_at,
             (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id) AS active_sessions
      FROM users u ORDER BY u.id
    `)) as unknown as {
      rows: {
        id: number;
        username: string;
        is_admin: boolean;
        disabled_at: Date | null;
        must_change_password: boolean;
        created_at: Date;
        active_sessions: number;
      }[];
    };
    if (rows.rows.length === 0) {
      console.log('库中还没有任何账号。用 npm run create-user -- <用户名> 创建第一个（自动成为管理员）。');
      return;
    }
    console.log(`共 ${rows.rows.length} 个账号：`);
    for (const r of rows.rows) {
      const tags = [
        r.is_admin ? '管理员' : '普通用户',
        r.disabled_at ? '已禁用' : '启用中',
        r.must_change_password ? '待改密' : null,
      ].filter(Boolean);
      console.log(`  #${r.id} ${r.username}  [${tags.join(' / ')}]  会话 ${r.active_sessions}`);
    }
    return;
  }

  const username = positionals[0];
  if (!username) throw new UsageError(`缺少用户名\n\n${USAGE}`);
  assertValidUsername(username);

  /** rename 的新用户名、以及 create/update 的显式初始密码 */
  const renameTarget = mode === 'rename' ? positionals[1] : undefined;
  let explicitPassword = mode === 'rename' ? undefined : positionals[1];

  if (mode === 'rename') {
    if (!renameTarget) throw new UsageError('--rename 需要给出新用户名：npm run create-user -- <用户名> --rename <新用户名>');
    if (positionals[2]) throw new UsageError('--rename 只改用户名、不改密码；如需同时重置密码请分两步执行');
    assertValidUsername(renameTarget);
  }

  if (passwordFromStdin) {
    if (mode !== 'create' && mode !== 'update') throw new UsageError('--password-stdin 只适用于创建账号或重置密码');
    if (explicitPassword) throw new UsageError('已经给了密码参数，就不要再从标准输入读了');
    explicitPassword = await readPasswordFromStdin();
    if (!explicitPassword) throw new UsageError('从标准输入没有读到密码');
  }

  if (mode !== 'create' && mode !== 'update' && explicitPassword) {
    throw new UsageError('只有创建账号或重置密码时才接受密码参数');
  }

  const outcome = await db.transaction(async (tx) => {
    // FOR UPDATE 串行化并发调用，避免两个进程同时判定"库中还没有账号"而各建一个
    const existing = (await tx.execute(
      sql`SELECT id, username, is_admin, disabled_at FROM users ORDER BY id FOR UPDATE`,
    )) as unknown as { rows: UserRow[] };
    const all = existing.rows ?? [];
    const current = all.find((u) => u.username === username);

    if (mode === 'create') {
      if (current) {
        throw new Error(
          `账号 ${username} 已存在。改密码用 --update；禁用用 --disable；更名用 --rename。`,
        );
      }

      const firstEver = all.length === 0;
      // 首个账号必须是管理员，否则没有人能再管理账号（把自己锁在门外的经典故障）
      const isAdmin = firstEver ? true : wantsAdmin;
      if (wantsAdmin && firstEver) {
        console.log('（库中原本没有账号：首个账号自动成为管理员）');
      }

      const password = explicitPassword ?? generatePassword();
      const strengthIssue = checkPasswordStrength(password);
      const passwordHash = await hashPassword(password);
      const created = (await tx.execute(sql`
        INSERT INTO users (username, password_hash, is_admin, must_change_password)
        VALUES (${username}, ${passwordHash}, ${isAdmin}, true)
        RETURNING id, username
      `)) as unknown as { rows: { id: number; username: string }[] };
      const row = created.rows[0]!;
      await tx.insert(auditLogs).values({
        userId: row.id,
        action: 'user.created',
        detail: { via: 'cli', isAdmin },
      });
      return {
        kind: 'created' as const,
        username: row.username,
        isAdmin,
        password,
        strengthIssue,
        generated: !explicitPassword,
      };
    }

    if (!current) throw new Error(`账号 ${username} 不存在`);

    if (mode === 'update') {
      const password = explicitPassword ?? generatePassword();
      const strengthIssue = checkPasswordStrength(password);
      const passwordHash = await hashPassword(password);
      await tx
        .update(users)
        .set({
          passwordHash,
          mustChangePassword: true,
          passwordChangedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, current.id));
      // 重置密码后强制所有旧会话失效
      await tx.delete(sessions).where(eq(sessions.userId, current.id));
      await tx.insert(auditLogs).values({
        userId: current.id,
        action: 'user.password_reset',
        detail: { via: 'cli' },
      });
      return {
        kind: 'password_reset' as const,
        username: current.username,
        password,
        strengthIssue,
        generated: !explicitPassword,
      };
    }

    if (mode === 'rename') {
      if (current.username === renameTarget) throw new Error(`新用户名与现有用户名相同（${renameTarget}），无需更名`);
      if (all.some((u) => u.username === renameTarget)) throw new Error(`账号 ${renameTarget} 已存在`);
      await tx
        .update(users)
        .set({ username: renameTarget!, updatedAt: new Date() })
        .where(eq(users.id, current.id));
      // 用户名是登录凭据的一部分，更名后所有旧会话立即失效
      await tx.delete(sessions).where(eq(sessions.userId, current.id));
      await tx.insert(auditLogs).values({
        userId: current.id,
        action: 'user.renamed',
        detail: { via: 'cli', from: current.username, to: renameTarget },
      });
      return { kind: 'renamed' as const, username: renameTarget!, previous: current.username };
    }

    if (mode === 'disable') {
      if (current.disabled_at) throw new Error(`账号 ${username} 已经是禁用状态`);
      const enabledAdmins = all.filter((u) => u.is_admin && !u.disabled_at);
      if (current.is_admin && enabledAdmins.length <= 1) {
        throw new Error(
          `账号 ${username} 是唯一启用中的管理员，禁用它将没有人能再管理账号。` +
            `请先用 --admin 新建另一个管理员账号。`,
        );
      }
      await tx.update(users).set({ disabledAt: new Date(), updatedAt: new Date() }).where(eq(users.id, current.id));
      await tx.delete(sessions).where(eq(sessions.userId, current.id));
      await tx.insert(auditLogs).values({ userId: current.id, action: 'user.disabled', detail: { via: 'cli' } });
      return { kind: 'disabled' as const, username: current.username };
    }

    // enable
    if (!current.disabled_at) throw new Error(`账号 ${username} 当前并未被禁用`);
    await tx.update(users).set({ disabledAt: null, updatedAt: new Date() }).where(eq(users.id, current.id));
    await tx.insert(auditLogs).values({ userId: current.id, action: 'user.enabled', detail: { via: 'cli' } });
    return { kind: 'enabled' as const, username: current.username };
  });

  // ── 结果输出 ──
  switch (outcome.kind) {
    case 'created':
      console.log(
        `已创建账号：${outcome.username}（${outcome.isAdmin ? '管理员' : '普通用户'}）`,
      );
      break;
    case 'password_reset':
      console.log(`已重置账号 ${outcome.username} 的密码，旧会话已全部失效`);
      break;
    case 'renamed':
      console.log(`已将账号 ${outcome.previous} 重命名为 ${outcome.username}，旧会话已全部失效`);
      break;
    case 'disabled':
      console.log(`已禁用账号 ${outcome.username}，其全部会话已失效`);
      break;
    case 'enabled':
      console.log(`已启用账号 ${outcome.username}`);
      break;
  }

  if (outcome.kind === 'created' || outcome.kind === 'password_reset') {
    console.log('');
    console.log(outcome.generated ? '初始密码（系统生成，仅显示这一次）：' : '初始密码（按你指定的值设置）：');
    console.log(`  ${outcome.password}`);
    if (outcome.strengthIssue) {
      console.log('');
      console.log(`⚠️  该初始密码不满足强度策略：${outcome.strengthIssue}`);
    }
    console.log('');
    console.log('该账号首次登录后必须先设置自己的新密码，在此之前无法使用任何业务功能。');
  }

  // ── 收尾自检：断言本次操作真的达成了预期状态，而不是"命令没报错" ──
  await selfCheck(outcome);
}

async function selfCheck(outcome: { kind: string; username: string; previous?: string }): Promise<void> {
  const rows = (await db.execute(sql`
    SELECT username, is_admin, disabled_at, must_change_password FROM users
  `)) as unknown as { rows: { username: string; is_admin: boolean; disabled_at: Date | null; must_change_password: boolean }[] };
  const found = rows.rows.filter((r) => r.username === outcome.username);

  const fail = (reason: string): never => {
    console.error(`自检失败：${reason}。请立即人工核查 users 表，本命令不再做任何修改。`);
    process.exit(1);
  };

  if (outcome.kind === 'renamed') {
    if (rows.rows.some((r) => r.username === outcome.previous)) fail(`更名后旧用户名 ${outcome.previous} 仍然存在`);
  }

  if (found.length !== 1) fail(`账号 ${outcome.username} 在库中出现 ${found.length} 次，应为 1 次`);

  switch (outcome.kind) {
    case 'created':
      break;
    case 'password_reset':
      if (!found[0]!.must_change_password) fail(`账号 ${outcome.username} 未置为必须改密`);
      break;
    case 'disabled':
      if (!found[0]!.disabled_at) fail(`账号 ${outcome.username} 未真正被禁用`);
      break;
    case 'enabled':
      if (found[0]!.disabled_at) fail(`账号 ${outcome.username} 仍处于禁用状态`);
      break;
    default:
      break;
  }
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('执行失败:', err instanceof Error ? err.message : err);
    await pool.end().catch(() => undefined);
    process.exit(err instanceof UsageError ? 2 : 1);
  });

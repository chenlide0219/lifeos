/**
 * 管理员账户初始化与维护（PRD FR-01：仅本人、单管理员，不开放注册）
 *
 * 用法：
 *   npm run create-admin -- <用户名>              # 首次初始化；库中已有管理员则拒绝
 *   npm run create-admin -- <用户名> --update     # 重置唯一管理员的密码（用户名必须匹配现有账号）
 *   npm run create-admin -- <用户名> --rename     # 重命名唯一管理员（事务处理，并撤销全部会话）
 *
 * 本系统**始终只有一个管理员**：
 * - 库中已存在管理员时，任何操作都不会新增第二行；
 * - 更名是 UPDATE 现有唯一账户，不是新建账号；
 * - 系统不提供注册入口与密码找回，忘记密码只能用本命令重置。
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../server/db/client';
import { adminUsers, auditLogs, sessions } from '../server/db/schema';
import { assertPasswordStrength, hashPassword } from '../server/lib/password';

function generatePassword(): string {
  // 保证四类字符齐全，长度 20
  const sets = ['abcdefghijkmnopqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '!@#$%^&*-_=+'];
  const pick = (set: string) => set[crypto.randomInt(set.length)]!;
  const chars = sets.map(pick);
  const all = sets.join('');
  while (chars.length < 20) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

type AdminRow = { id: number; username: string };

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const update = argv.includes('--update');
  const rename = argv.includes('--rename');
  const positional = argv.filter((a) => !a.startsWith('--'));
  const username = positional[0];
  const explicitPassword = positional[1];

  if (update && rename) {
    console.error('--update 与 --rename 不能同时使用');
    process.exit(2);
  }

  if (rename && positional[1]) {
    console.error('--rename 只改用户名、不改密码；如需同时重置密码请分两步执行');
    process.exit(2);
  }

  if (!username) {
    console.error('用法: npm run create-admin -- <用户名> [密码] [--update|--rename]');
    process.exit(2);
  }

  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
    console.error('用户名只能包含字母、数字、下划线、点、连字符，长度 3-64');
    process.exit(2);
  }

  const password = explicitPassword ?? generatePassword();
  assertPasswordStrength(password);

  const outcome = await db.transaction(async (tx) => {
    // FOR UPDATE 串行化并发调用，避免两个进程同时判定"库中无管理员"而各建一个
    const existing = (await tx.execute(
      sql`SELECT id, username FROM admin_users ORDER BY id FOR UPDATE`,
    )) as unknown as { rows: AdminRow[] };
    const admins = existing.rows ?? [];

    if (admins.length > 1) {
      // 不应出现：单管理员是产品不变量。出现即数据完整性问题，绝不静默继续。
      throw new Error(
        `数据异常：库中存在 ${admins.length} 个管理员（${admins.map((a) => a.username).join(', ')}）。` +
          `单管理员是产品不变量，请先人工核对后再操作，本命令不做任何修改。`,
      );
    }

    const current = admins[0];

    // ── 首次初始化 ──
    if (!current) {
      if (update) throw new Error('库中还没有管理员，--update 无对象；请去掉该参数执行首次初始化');
      if (rename) throw new Error('库中还没有管理员，--rename 无对象；请去掉该参数执行首次初始化');

      const passwordHash = await hashPassword(password);
      const created = (await tx.execute(
        sql`INSERT INTO admin_users (username, password_hash) VALUES (${username}, ${passwordHash}) RETURNING id, username`,
      )) as unknown as { rows: AdminRow[] };
      const row = created.rows[0]!;
      await tx.insert(auditLogs).values({
        userId: row.id,
        action: 'admin.created',
        detail: { via: 'cli' },
      });
      return { kind: 'created' as const, username: row.username };
    }

    // ── 库中已有唯一管理员：绝不再新增一行 ──

    if (update) {
      if (current.username !== username) {
        throw new Error(
          `库中已有管理员 ${current.username}，与传入的 ${username} 不一致。` +
            `重置密码请使用现有用户名；如需更名请改用 --rename。`,
        );
      }
      const passwordHash = await hashPassword(password);
      await tx.update(adminUsers).set({ passwordHash, updatedAt: new Date() }).where(eq(adminUsers.id, current.id));
      // 重置密码后强制所有旧会话失效
      await tx.delete(sessions).where(eq(sessions.userId, current.id));
      await tx.insert(auditLogs).values({
        userId: current.id,
        action: 'admin.password_reset',
        detail: { via: 'cli' },
      });
      return { kind: 'password_reset' as const, username: current.username };
    }

    if (rename) {
      if (current.username === username) {
        throw new Error(`新用户名与现有用户名相同（${username}），无需更名`);
      }
      // 更名 = 更新唯一账户，而不是新增账号
      await tx.update(adminUsers).set({ username, updatedAt: new Date() }).where(eq(adminUsers.id, current.id));
      // 用户名是登录凭据的一部分，更名后所有旧会话立即失效
      await tx.delete(sessions).where(eq(sessions.userId, current.id));
      await tx.insert(auditLogs).values({
        userId: current.id,
        action: 'admin.renamed',
        detail: { via: 'cli', from: current.username, to: username },
      });
      return { kind: 'renamed' as const, username, previous: current.username };
    }

    throw new Error(
      `库中已存在管理员 ${current.username}，本命令不会创建第二个管理员。\n` +
        `  重置其密码： npm run create-admin -- ${current.username} --update\n` +
        `  重命名账号： npm run create-admin -- <新用户名> --rename`,
    );
  });

  switch (outcome.kind) {
    case 'created':
      console.log(`已创建管理员账号：${outcome.username}（当前共 1 个管理员）`);
      break;
    case 'password_reset':
      console.log(`已重置账号 ${outcome.username} 的密码，旧会话已全部失效（管理员数量仍为 1）`);
      break;
    case 'renamed':
      console.log(
        `已将管理员 ${outcome.previous} 重命名为 ${outcome.username}，旧会话已全部失效（管理员数量仍为 1）`,
      );
      break;
  }

  if (!explicitPassword && outcome.kind !== 'renamed') {
    console.log('');
    console.log('初始密码（仅显示这一次，请立即保存到密码管理器）：');
    console.log(`  ${password}`);
    console.log('');
  }

  // 收尾自检：操作后必须仍然只有一个管理员
  const after = (await db.execute(sql`SELECT count(*)::int AS n FROM admin_users`)) as unknown as {
    rows: { n: number }[];
  };
  const count = after.rows[0]?.n ?? -1;
  if (count !== 1) {
    console.error(`自检失败：操作后管理员数量为 ${count}，应为 1。请立即人工核查 admin_users 表。`);
    process.exit(1);
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
    process.exit(1);
  });

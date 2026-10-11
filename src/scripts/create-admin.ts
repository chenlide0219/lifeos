/**
 * 首次初始化：创建唯一管理员账号（PRD FR-01）
 *
 * 用法：
 *   npm run create-admin -- <用户名>              # 随机生成强密码并打印一次
 *   npm run create-admin -- <用户名> <密码>        # 指定密码
 *   npm run create-admin -- <用户名> --update      # 重置已有账号密码（随机）
 *
 * 系统不提供注册入口与密码找回，忘记密码只能用本命令重置。
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../server/db/client';
import { adminUsers, auditLogs } from '../server/db/schema';
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

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const update = process.argv.includes('--update');
  const username = args[0];
  const explicitPassword = args[1];

  if (!username) {
    console.error('用法: npm run create-admin -- <用户名> [密码] [--update]');
    process.exit(1);
  }

  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
    console.error('用户名只能包含字母、数字、下划线、点、连字符，长度 3-64');
    process.exit(1);
  }

  const password = explicitPassword ?? generatePassword();
  assertPasswordStrength(password);

  const [existing] = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.username, username))
    .limit(1);

  const passwordHash = await hashPassword(password);

  if (existing) {
    if (!update) {
      console.error(`账号 ${username} 已存在。如需重置密码请加 --update`);
      process.exit(1);
    }
    await db
      .update(adminUsers)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(adminUsers.id, existing.id));
    // 重置密码后强制所有旧会话失效
    await db.execute(sql`DELETE FROM sessions WHERE user_id = ${existing.id}`);
    await db.insert(auditLogs).values({ userId: existing.id, action: 'admin.password_reset', detail: { via: 'cli' } });
    console.log(`已重置账号 ${username} 的密码，旧会话已全部失效。`);
  } else {
    const [created] = await db
      .insert(adminUsers)
      .values({ username, passwordHash })
      .returning({ id: adminUsers.id });
    await db.insert(auditLogs).values({
      userId: created?.id ?? null,
      action: 'admin.created',
      detail: { via: 'cli' },
    });
    console.log(`已创建管理员账号：${username}`);
  }

  if (!explicitPassword) {
    console.log('');
    console.log('初始密码（仅显示这一次，请立即保存到密码管理器）：');
    console.log(`  ${password}`);
    console.log('');
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

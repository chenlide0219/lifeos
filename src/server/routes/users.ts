/**
 * 账号管理（仅管理员，设置页使用）。
 *
 * 产品约束（已确认）：
 * - **不开放注册**：账号只能由管理员在这里创建，或在服务器上跑 `create-user`；
 * - **不做删除**：禁用是唯一的"收回访问"手段。删除会连带清掉该账号的全部业务数据
 *   （所有业务表都是 `ON DELETE CASCADE`），那是不可逆的，不该由界面上的一个按钮触发；
 * - **不做角色变更**：创建时决定是否管理员，之后不能改。原因是一旦允许"把最后一个
 *   管理员降级"，就会出现无人能管理账号的死局；需要调整角色时用 CLI 显式操作；
 * - **重置密码 = 系统生成一次性密码 + 强制对方首次登录改密**：管理员不该知道、
 *   也不该设定别人的长期密码。
 */
import { Hono } from 'hono';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { auditLogs, sessions, users } from '../db/schema';
import { generateStrongPassword, hashPassword } from '../lib/password';
import { rateLimit } from '../lib/ratelimit';
import { clientIp, requireAdmin, requireAuth, type AppEnv } from '../middleware/auth';

export const userRoutes = new Hono<AppEnv>();

userRoutes.use('*', requireAuth);
userRoutes.use('*', requireAdmin);

type UserRow = {
  id: number;
  username: string;
  isAdmin: boolean;
  disabledAt: Date | null;
  mustChangePassword: boolean;
  createdAt: Date;
};

function view(row: UserRow, activeSessions = 0) {
  return {
    id: row.id,
    username: row.username,
    isAdmin: row.isAdmin,
    disabled: row.disabledAt !== null,
    mustChangePassword: row.mustChangePassword,
    activeSessions,
    createdAt: row.createdAt.toISOString(),
  };
}

async function sessionCounts(userIds: number[]): Promise<Map<number, number>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ userId: sessions.userId, n: sql<number>`count(*)::int` })
    .from(sessions)
    .where(inArray(sessions.userId, userIds))
    .groupBy(sessions.userId);
  return new Map(rows.map((r) => [r.userId, r.n]));
}

async function recordAudit(userId: number | null, action: string, detail: unknown, ip: string): Promise<void> {
  try {
    await db.insert(auditLogs).values({ userId, action, detail: detail ?? null, ip });
  } catch (err) {
    console.error('[audit] 写入失败:', (err as Error).message);
  }
}

/** 账号列表：管理界面据此渲染，不含任何凭据材料 */
userRoutes.get('/', async (c) => {
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      isAdmin: users.isAdmin,
      disabledAt: users.disabledAt,
      mustChangePassword: users.mustChangePassword,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.id));

  const counts = await sessionCounts(rows.map((r) => r.id));
  return c.json({
    users: rows.map((r) => view(r, counts.get(r.id) ?? 0)),
    /** 界面据此解释"为什么不能禁用他自己" */
    currentUserId: c.get('user').id,
  });
});

/** 新增账号：返回**只显示这一次**的一次性初始密码 */
userRoutes.post('/', async (c) => {
  const ip = clientIp(c);
  const limit = rateLimit(`users:create:${c.get('user').id}`, 20, 60 * 60 * 1000);
  if (!limit.ok) {
    return c.json({ error: 'rate_limited', message: `操作过于频繁，请 ${limit.retryAfterSeconds} 秒后再试` }, 429);
  }

  const body = (await c.req.json().catch(() => null)) as { username?: unknown; isAdmin?: unknown } | null;
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const isAdmin = body?.isAdmin === true;

  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
    return c.json(
      { error: 'invalid_request', message: '用户名只能包含字母、数字、下划线、点、连字符，长度 3-64' },
      400,
    );
  }

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
  if (existing) {
    return c.json({ error: 'username_taken', message: `账号 ${username} 已存在` }, 409);
  }

  const initialPassword = generateStrongPassword();
  const passwordHash = await hashPassword(initialPassword);

  const [created] = await db
    .insert(users)
    .values({ username, passwordHash, isAdmin, mustChangePassword: true })
    .returning({
      id: users.id,
      username: users.username,
      isAdmin: users.isAdmin,
      disabledAt: users.disabledAt,
      mustChangePassword: users.mustChangePassword,
      createdAt: users.createdAt,
    });

  await recordAudit(created!.id, 'user.created', { via: 'web', isAdmin }, ip);

  return c.json(
    {
      user: view(created!),
      initialPassword,
      notice: '该密码只显示这一次。对方首次登录后必须先设置自己的新密码，在此之前无法使用任何业务功能。',
    },
    201,
  );
});

/** 禁用：立刻撤销该账号全部会话；不允许禁用自己或最后一个启用中的管理员 */
userRoutes.post('/:id/disable', async (c) => {
  const ip = clientIp(c);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'invalid_request', message: '账号 ID 不正确' }, 400);
  }

  const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!target) return c.json({ error: 'not_found', message: '账号不存在' }, 404);
  if (target.disabledAt) return c.json({ error: 'already_disabled', message: '该账号已经是禁用状态' }, 409);

  if (target.id === c.get('user').id) {
    return c.json({ error: 'invalid_state', message: '不能禁用当前登录的账号（那会让你立刻掉线且无法恢复）' }, 409);
  }

  if (target.isAdmin) {
    const enabledAdmins = (await db.execute(sql`
      SELECT count(*)::int AS n FROM users WHERE is_admin AND disabled_at IS NULL
    `)) as unknown as { rows: { n: number }[] };
    if ((enabledAdmins.rows[0]?.n ?? 0) <= 1) {
      return c.json(
        { error: 'invalid_state', message: '这是唯一启用中的管理员，禁用后将没有人能再管理账号' },
        409,
      );
    }
  }

  await db.update(users).set({ disabledAt: new Date(), updatedAt: new Date() }).where(eq(users.id, id));
  await db.delete(sessions).where(eq(sessions.userId, id));
  await recordAudit(id, 'user.disabled', { via: 'web' }, ip);

  return c.json({ ok: true });
});

/** 启用：只是清掉禁用标记，不会恢复之前已失效的会话 */
userRoutes.post('/:id/enable', async (c) => {
  const ip = clientIp(c);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'invalid_request', message: '账号 ID 不正确' }, 400);
  }

  const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!target) return c.json({ error: 'not_found', message: '账号不存在' }, 404);
  if (!target.disabledAt) return c.json({ error: 'already_enabled', message: '该账号当前并未被禁用' }, 409);

  await db.update(users).set({ disabledAt: null, updatedAt: new Date() }).where(eq(users.id, id));
  await recordAudit(id, 'user.enabled', { via: 'web' }, ip);

  return c.json({ ok: true });
});

/** 重置密码：生成一次性密码、强制对方改密、并立刻撤销其全部会话 */
userRoutes.post('/:id/reset-password', async (c) => {
  const ip = clientIp(c);
  const limit = rateLimit(`users:reset:${c.get('user').id}`, 20, 60 * 60 * 1000);
  if (!limit.ok) {
    return c.json({ error: 'rate_limited', message: `操作过于频繁，请 ${limit.retryAfterSeconds} 秒后再试` }, 429);
  }

  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'invalid_request', message: '账号 ID 不正确' }, 400);
  }

  const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!target) return c.json({ error: 'not_found', message: '账号不存在' }, 404);

  const initialPassword = generateStrongPassword();
  const passwordHash = await hashPassword(initialPassword);

  await db
    .update(users)
    .set({
      passwordHash,
      mustChangePassword: true,
      passwordChangedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, id));
  await db.delete(sessions).where(eq(sessions.userId, id));
  await recordAudit(id, 'user.password_reset', { via: 'web' }, ip);

  return c.json({
    user: view({ ...target, mustChangePassword: true }),
    initialPassword,
    notice: '该密码只显示这一次。对方下次登录后必须先设置自己的新密码。',
  });
});

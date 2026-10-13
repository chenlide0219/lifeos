import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db/client';
import { users, auditLogs, sessions } from '../db/schema';
import { assertPasswordStrength, dummyVerify, hashPassword, verifyPassword } from '../lib/password';
import { rateLimit, resetRateLimit } from '../lib/ratelimit';
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  hashToken,
  sessionCookieOptions,
  toPublicUser,
} from '../lib/session';
import { clientIp, requireAuth, type AppEnv } from '../middleware/auth';

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_IP_LIMIT = 20;
const LOGIN_USER_LIMIT = 5;

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/login', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { username?: unknown; password?: unknown }
    | null;

  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!username || !password) {
    return c.json({ error: 'invalid_request', message: '请输入用户名和密码' }, 400);
  }

  const ip = clientIp(c);

  // 双维度限速：单 IP 防扫描，单账号防定向爆破（PRD FR-01 验收项）
  const ipLimit = rateLimit(`login:ip:${ip}`, LOGIN_IP_LIMIT, LOGIN_WINDOW_MS);
  if (!ipLimit.ok) {
    return c.json(
      { error: 'rate_limited', message: `尝试过于频繁，请 ${ipLimit.retryAfterSeconds} 秒后再试` },
      429,
      { 'Retry-After': String(ipLimit.retryAfterSeconds) },
    );
  }

  const userLimit = rateLimit(`login:user:${username.toLowerCase()}`, LOGIN_USER_LIMIT, LOGIN_WINDOW_MS);
  if (!userLimit.ok) {
    await recordAudit(null, 'login.rate_limited', { username }, ip);
    return c.json(
      { error: 'rate_limited', message: `该账号尝试次数过多，请 ${userLimit.retryAfterSeconds} 秒后再试` },
      429,
      { 'Retry-After': String(userLimit.retryAfterSeconds) },
    );
  }

  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      passwordHash: users.passwordHash,
      isAdmin: users.isAdmin,
      mustChangePassword: users.mustChangePassword,
      disabledAt: users.disabledAt,
    })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (!user) {
    // 等时失败：不暴露账号是否存在
    await dummyVerify(password);
    await recordAudit(null, 'login.failed', { username, reason: 'no_such_user' }, ip);
    return c.json({ error: 'invalid_credentials', message: '用户名或密码不正确' }, 401);
  }

  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) {
    await recordAudit(user.id, 'login.failed', { username, reason: 'bad_password' }, ip);
    return c.json({ error: 'invalid_credentials', message: '用户名或密码不正确' }, 401);
  }

  /**
   * 禁用判定放在**密码校验之后**：
   *
   * 放在之前会让"账号是否存在/是否被禁用"通过响应时间泄露给未持有密码的人。
   * 放在之后，只有已经知道正确密码的人才会走到这里，而返回的仍然是
   * 与密码错误**完全相同**的措辞与状态码，因此对外不区分"禁用"与"密码错"；
   * 真实原因只写进审计日志，供管理员排查。
   */
  if (user.disabledAt) {
    await recordAudit(user.id, 'login.disabled', { username }, ip);
    return c.json({ error: 'invalid_credentials', message: '用户名或密码不正确' }, 401);
  }

  const { token, expiresAt } = await createSession(user.id, {
    userAgent: c.req.header('user-agent'),
    ip,
  });

  setCookie(c, SESSION_COOKIE, token, {
    ...sessionCookieOptions,
    expires: expiresAt,
  });

  resetRateLimit(`login:user:${username.toLowerCase()}`);
  await recordAudit(user.id, 'login.success', null, ip);

  return c.json({ user: toPublicUser(user) });
});

authRoutes.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await destroySession(token);
  }
  deleteCookie(c, SESSION_COOKIE, { path: sessionCookieOptions.path });
  return c.json({ ok: true });
});

authRoutes.get('/me', requireAuth, (c) => {
  return c.json({ user: toPublicUser(c.get('user')) });
});

/**
 * 修改密码：属于敏感操作，要求重新验证当前密码（PRD FR-01）。
 * 修改成功后其他设备会话立即失效，当前设备保持登录。
 */
authRoutes.post('/password', requireAuth, async (c) => {
  const user = c.get('user');
  const ip = clientIp(c);

  const limit = rateLimit(`password:${user.id}`, 5, LOGIN_WINDOW_MS);
  if (!limit.ok) {
    return c.json(
      { error: 'rate_limited', message: `操作过于频繁，请 ${limit.retryAfterSeconds} 秒后再试` },
      429,
    );
  }

  const body = (await c.req.json().catch(() => null)) as
    | { currentPassword?: unknown; newPassword?: unknown }
    | null;

  const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';

  if (!currentPassword || !newPassword) {
    return c.json({ error: 'invalid_request', message: '请填写当前密码与新密码' }, 400);
  }

  if (newPassword === currentPassword) {
    return c.json({ error: 'invalid_request', message: '新密码不能与当前密码相同' }, 400);
  }

  try {
    assertPasswordStrength(newPassword);
  } catch (err) {
    return c.json({ error: 'weak_password', message: (err as Error).message }, 400);
  }

  const [row] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  if (!row) {
    return c.json({ error: 'unauthorized', message: '账号不存在' }, 401);
  }

  const valid = await verifyPassword(row.passwordHash, currentPassword);
  if (!valid) {
    await recordAudit(user.id, 'password.change_failed', { reason: 'bad_current_password' }, ip);
    return c.json({ error: 'invalid_credentials', message: '当前密码不正确' }, 401);
  }

  const passwordHash = await hashPassword(newPassword);
  await db
    .update(users)
    .set({
      passwordHash,
      // 改密成功即解除强制改密：这也是管理端"重置密码"被解除的唯一出口
      mustChangePassword: false,
      passwordChangedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  // 其余设备下线，当前会话保留
  const token = getCookie(c, SESSION_COOKIE);
  await db
    .delete(sessions)
    .where(
      and(
        eq(sessions.userId, user.id),
        token ? ne(sessions.tokenHash, hashToken(token)) : undefined,
      ),
    );

  await recordAudit(user.id, 'password.changed', null, ip);
  return c.json({ ok: true });
});

async function recordAudit(
  userId: number | null,
  action: string,
  detail: unknown,
  ip: string,
): Promise<void> {
  try {
    await db.insert(auditLogs).values({ userId, action, detail: detail ?? null, ip });
  } catch (err) {
    // 审计失败不能阻断登录流程，但必须留下痕迹
    console.error('[audit] 写入失败:', (err as Error).message);
  }
}

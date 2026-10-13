import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie } from 'hono/cookie';
import { SESSION_COOKIE, resolveSession, sessionCookieOptions, type SessionUser } from '../lib/session';

export type AppEnv = {
  Variables: {
    user: SessionUser;
  };
};

/**
 * 只信任来自本机 Nginx 的转发头：Node 仅监听 127.0.0.1，
 * 外部无法直连伪造 X-Real-IP。
 */
export function clientIp(c: Context): string {
  const real = c.req.header('x-real-ip');
  if (real) return real.trim();
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return 'unknown';
}

/**
 * 强制改密期间仍然必须可用的端点。
 *
 * 必须包含 `/auth/me`：前端要靠它判断"我是否处于必须改密状态"；
 * 若把它也拒掉，前端只会看到一片 403，无法给出正确的引导。
 */
const PASSWORD_ROTATION_ALLOWLIST = new Set([
  '/health',
  '/auth/login',
  '/auth/logout',
  '/auth/me',
  '/auth/password',
]);

/** 把挂载前缀去掉，使同一份清单在 `/api/x` 与 `/x` 两种挂载方式下都成立 */
function normalizedPath(c: Context): string {
  return c.req.path.replace(/^\/api(?=\/|$)/, '');
}

/**
 * 强制改密闸门（全局中间件，注册在**路由之前**）。
 *
 * 为什么放在全局而不是逐个路由：
 * `requireAuth` 是每个路由自己挂的，将来新增路由时任何人漏挂都不会有明显症状。
 * 强制改密是安全策略，"漏挂"等于策略被静默绕过，因此必须在框架层统一执行，
 * 只对少数必需端点例外（白名单），新增路由默认被覆盖。
 *
 * 这里解析出的用户写回上下文，`requireAuth` 会复用，避免同一请求查两次库。
 */
export const enforcePasswordRotation: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    await next();
    return;
  }

  const user = await resolveSession(token);
  if (!user) {
    // 未登录/会话失效/账号被禁用：交给 requireAuth 统一给出 401，避免两处措辞不一致
    await next();
    return;
  }

  c.set('user', user);

  if (user.mustChangePassword && !PASSWORD_ROTATION_ALLOWLIST.has(normalizedPath(c))) {
    return c.json(
      { error: 'password_change_required', message: '首次登录（或密码被重置）后必须先设置新密码' },
      403,
    );
  }

  await next();
};

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  // 上层中间件已解析并写入用户时直接复用，避免重复查询会话表
  if (c.get('user')) {
    await next();
    return;
  }

  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    return c.json({ error: 'unauthorized', message: '请先登录' }, 401);
  }

  const user = await resolveSession(token);
  if (!user) {
    deleteCookie(c, SESSION_COOKIE, { path: sessionCookieOptions.path });
    return c.json({ error: 'unauthorized', message: '会话已失效，请重新登录' }, 401);
  }

  c.set('user', user);
  await next();
};

/**
 * 账号管理权限。**必须挂在 `requireAuth` 之后**。
 *
 * 注意这里返回 403 而不是 404：与"别人的业务数据"不同，账号管理端点的存在性
 * 对已登录用户并不是秘密（设置页本来就会显示入口），这里要表达的是"你没有这个权限"，
 * 返回 404 只会让用户以为是前端 bug。
 */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'unauthorized', message: '请先登录' }, 401);
  }
  if (!user.isAdmin) {
    return c.json({ error: 'forbidden', message: '只有管理员可以管理账号' }, 403);
  }
  await next();
};

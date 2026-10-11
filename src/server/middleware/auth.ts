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

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
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

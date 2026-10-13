import crypto from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db/client';
import { sessions, users } from '../db/schema';

export const SESSION_COOKIE = 'lifeos_session';

export type SessionUser = {
  id: number;
  username: string;
  isAdmin: boolean;
  /** 为真时除改密相关端点外的接口一律拒绝（见 middleware/auth.ts） */
  mustChangePassword: boolean;
};

/** 对外暴露的账号字段：绝不包含 password_hash 或任何凭据材料 */
export function toPublicUser(user: SessionUser) {
  return {
    id: user.id,
    username: user.username,
    isAdmin: user.isAdmin,
    mustChangePassword: user.mustChangePassword,
  };
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** 数据库只保存哈希：库被读取也无法直接冒用会话 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  userId: number,
  meta: { userAgent?: string; ip?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000);

  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    userAgent: meta.userAgent?.slice(0, 400),
    ip: meta.ip?.slice(0, 64),
  });

  return { token, expiresAt };
}

export async function resolveSession(token: string): Promise<SessionUser | null> {
  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      username: users.username,
      isAdmin: users.isAdmin,
      mustChangePassword: users.mustChangePassword,
      disabledAt: users.disabledAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (!row) return null;

  /**
   * 被禁用的账号立即失效，并顺手销毁该会话。
   *
   * 只在"创建会话时"拦禁用是不够的：禁用发生时旧 Cookie 仍在有效期内，
   * 不在这里判断就等于禁用不生效。同时删掉会话行，避免每次请求都重复拒绝。
   */
  if (row.disabledAt) {
    await db.delete(sessions).where(eq(sessions.id, row.sessionId));
    return null;
  }

  // 活跃会话滑动续期，失败不影响本次请求
  void db
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(sessions.id, row.sessionId))
    .catch(() => undefined);

  return {
    id: row.userId,
    username: row.username,
    isAdmin: row.isAdmin,
    mustChangePassword: row.mustChangePassword,
  };
}

export async function destroySession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

export async function destroyAllSessions(userId: number): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export async function cleanupExpiredSessions(): Promise<number> {
  const deleted = await db.delete(sessions).where(lt(sessions.expiresAt, new Date())).returning({ id: sessions.id });
  return deleted.length;
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: config.secureCookies,
  sameSite: 'Lax' as const,
  path: '/',
};

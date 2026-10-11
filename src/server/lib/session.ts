import crypto from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db/client';
import { adminUsers, sessions } from '../db/schema';

export const SESSION_COOKIE = 'lifeos_session';

export type SessionUser = {
  id: number;
  username: string;
};

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
      userId: adminUsers.id,
      username: adminUsers.username,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(adminUsers, eq(sessions.userId, adminUsers.id))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (!row) return null;

  // 活跃会话滑动续期，失败不影响本次请求
  void db
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(sessions.id, row.sessionId))
    .catch(() => undefined);

  return { id: row.userId, username: row.username };
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

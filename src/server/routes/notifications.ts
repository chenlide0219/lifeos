import { Hono } from 'hono';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { notificationAttempts, notificationJobs } from '../db/schema';
import { getProviderStatuses } from '../lib/provider-status';
import { requireAuth, type AppEnv } from '../middleware/auth';
import { listProviders } from '../../worker/registry';

export const notificationRoutes = new Hono<AppEnv>();

const STATUSES = ['pending', 'sending', 'sent', 'failed', 'cancelled', 'skipped', 'missed'] as const;
type JobStatus = (typeof STATUSES)[number];

notificationRoutes.get('/providers', requireAuth, async (c) => {
  const { statuses, probedAt } = await getProviderStatuses();
  return c.json({ providers: statuses, probedAt });
});

/**
 * 通知任务记录（含错过原因）。
 * 这是 A7 要求的"错过记录必须可查询"的界面数据源。
 */
notificationRoutes.get('/jobs', requireAuth, async (c) => {
  const statusParam = c.req.query('status');
  const requested = (statusParam ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is JobStatus => (STATUSES as readonly string[]).includes(s));

  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200);
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);

  const where = requested.length > 0 ? inArray(notificationJobs.status, requested) : undefined;

  const rows = await db
    .select({
      id: notificationJobs.id,
      subjectType: notificationJobs.subjectType,
      subjectId: notificationJobs.subjectId,
      title: notificationJobs.title,
      status: notificationJobs.status,
      failureKind: notificationJobs.failureKind,
      fireAt: notificationJobs.fireAt,
      sentAt: notificationJobs.sentAt,
      attempts: notificationJobs.attempts,
      maxAttempts: notificationJobs.maxAttempts,
      lastError: notificationJobs.lastError,
      nextAttemptAt: notificationJobs.nextAttemptAt,
      createdAt: notificationJobs.createdAt,
    })
    .from(notificationJobs)
    .where(where)
    .orderBy(desc(notificationJobs.fireAt))
    .limit(limit)
    .offset(offset);

  const summaryRows = await db
    .select({ status: notificationJobs.status, count: sql<number>`count(*)::int` })
    .from(notificationJobs)
    .groupBy(notificationJobs.status);

  const summary: Record<string, number> = {};
  for (const s of STATUSES) summary[s] = 0;
  for (const row of summaryRows) summary[row.status] = row.count;

  const total = Object.values(summary).reduce((a, b) => a + b, 0);

  return c.json({
    jobs: rows,
    summary,
    total,
    limit,
    offset,
    // 未配置渠道时给出明确说明，避免"为什么不发"没有答案
    providerReady: listProviders().some((p) => p.isConfigured()),
  });
});

/** 单条任务的发送尝试明细 */
notificationRoutes.get('/jobs/:id/attempts', requireAuth, async (c) => {
  const id = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return c.json({ error: 'invalid_request', message: '任务 ID 格式不正确' }, 400);
  }

  const [job] = await db
    .select({ id: notificationJobs.id })
    .from(notificationJobs)
    .where(eq(notificationJobs.id, id))
    .limit(1);

  if (!job) {
    return c.json({ error: 'not_found', message: '任务不存在' }, 404);
  }

  const attempts = await db
    .select({
      id: notificationAttempts.id,
      attemptedAt: notificationAttempts.attemptedAt,
      success: notificationAttempts.success,
      error: notificationAttempts.error,
    })
    .from(notificationAttempts)
    .where(and(eq(notificationAttempts.jobId, id)))
    .orderBy(desc(notificationAttempts.attemptedAt))
    .limit(50);

  return c.json({ attempts });
});

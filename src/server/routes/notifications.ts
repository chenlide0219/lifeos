import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { notificationAttempts, notificationJobs } from '../db/schema';
import { getProviderStatuses } from '../lib/provider-status';
import { rateLimit } from '../lib/ratelimit';
import { clientIp, requireAuth, type AppEnv } from '../middleware/auth';
import { listProviders, refreshProviders } from '../../worker/registry';

export const notificationRoutes = new Hono<AppEnv>();

const STATUSES = ['pending', 'sending', 'sent', 'failed', 'cancelled', 'skipped', 'missed'] as const;
type JobStatus = (typeof STATUSES)[number];

notificationRoutes.get('/providers', requireAuth, async (c) => {
  const { statuses, probedAt } = await getProviderStatuses();
  return c.json({ providers: statuses, probedAt });
});

/**
 * 发送测试消息（PRD FR-07：设置页支持"发送测试微信消息"）。
 *
 * 关键约束：**不伪造结果**。
 *   - 渠道未配置 → 直接拒绝，不排队、不假装已发送；
 *   - 渠道已配置 → 只把任务排入队列，返回 jobId，由界面轮询真实结果；
 *     是否送达以通知任务与发送尝试的记录为准，绝不凭 HTTP 响应推断。
 */
notificationRoutes.post('/test', requireAuth, async (c) => {
  const limited = rateLimit(`notify-test:${clientIp(c)}`, 5, 10 * 60 * 1000);
  if (!limited.ok) {
    return c.json(
      { error: 'rate_limited', message: `测试消息发送过于频繁，请 ${limited.retryAfterSeconds} 秒后再试` },
      429,
    );
  }

  await refreshProviders();
  const provider = listProviders()[0];
  if (!provider || !provider.isConfigured()) {
    return c.json(
      {
        error: 'provider_not_configured',
        message: provider
          ? `发送通道未配置，测试消息未排队也不会发出。${provider.describe().detail}`
          : '没有注册任何通知渠道',
        provider: provider ? provider.describe() : null,
      },
      503,
    );
  }

  if (provider.canSend && !provider.canSend()) {
    return c.json({ error: 'wechat_paused', message: '微信发送已暂停，请在微信回复消息或发送 /refresh-context；测试消息未排队' }, 409);
  }

  const jobId = randomUUID();
  const now = new Date();

  const [job] = await db
    .insert(notificationJobs)
    .values({
      ruleId: null,
      subjectType: 'system',
      subjectId: randomUUID(),
      title: 'Life OS 测试消息',
      body: '这是一条测试消息，用于验证微信通道是否可用。收到即说明通道正常。',
      fireAt: now,
      status: 'pending',
      // 测试消息只尝试一次：用户就在跟前，失败会立刻看到，无需后台反复重试
      maxAttempts: 1,
      idempotencyKey: `test:${jobId}`,
    })
    .returning({ id: notificationJobs.id, status: notificationJobs.status, fireAt: notificationJobs.fireAt });

  return c.json(
    {
      job: job!,
      provider: provider.describe(),
      note: '已排入队列，Worker 会在下一次轮询时发送；结果以任务记录为准，界面会自动查询。',
    },
    202,
  );
});

/** 查询测试消息的真实结果（供界面轮询） */
notificationRoutes.get('/test/:jobId', requireAuth, async (c) => {
  const jobId = c.req.param('jobId');
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
    return c.json({ error: 'invalid_request', message: '任务 ID 格式不正确' }, 400);
  }

  const [job] = await db
    .select({
      id: notificationJobs.id,
      status: notificationJobs.status,
      failureKind: notificationJobs.failureKind,
      attempts: notificationJobs.attempts,
      maxAttempts: notificationJobs.maxAttempts,
      lastError: notificationJobs.lastError,
      fireAt: notificationJobs.fireAt,
      sentAt: notificationJobs.sentAt,
    })
    .from(notificationJobs)
    .where(and(eq(notificationJobs.id, jobId), eq(notificationJobs.subjectType, 'system')))
    .limit(1);

  if (!job) return c.json({ error: 'not_found', message: '测试任务不存在' }, 404);

  const attempts = await db
    .select({
      attemptedAt: notificationAttempts.attemptedAt,
      success: notificationAttempts.success,
      error: notificationAttempts.error,
    })
    .from(notificationAttempts)
    .where(eq(notificationAttempts.jobId, jobId))
    .orderBy(desc(notificationAttempts.attemptedAt))
    .limit(10);

  return c.json({ job, attempts });
});

/**
 * 通知任务记录（含错过原因）。
 * 这是 A7 要求的"错过记录必须可查询"的界面数据源。
 */
notificationRoutes.get('/jobs', requireAuth, async (c) => {
  await refreshProviders();
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

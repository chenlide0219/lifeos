import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db/client';
import { getProviderStatuses } from '../lib/provider-status';
import { requireAuth, type AppEnv } from '../middleware/auth';

export const statusRoutes = new Hono<AppEnv>();

const VERSION = '0.1.0';

/**
 * 系统状态：只报告"配置与否 / 是否可达"，**绝不返回密钥内容**（PRD FR-01）。
 */
statusRoutes.get('/', requireAuth, async (c) => {
  let dbStatus: 'up' | 'down' = 'down';
  try {
    await db.execute(sql`select 1`);
    dbStatus = 'up';
  } catch {
    dbStatus = 'down';
  }

  const asrKey = Boolean(process.env.MIMO_API_KEY);
  const llmKey = Boolean(process.env.DEEPSEEK_API_KEY);
  const { statuses, probedAt } = await getProviderStatuses();

  return c.json({
    version: VERSION,
    timezone: config.timezone,
    now: new Date().toISOString(),
    db: dbStatus,
    ai: {
      asr: {
        configured: asrKey,
        model: process.env.MIMO_ASR_MODEL ?? 'mimo-v2.5-asr',
        baseUrl: hostOf(process.env.MIMO_BASE_URL),
      },
      llm: {
        configured: llmKey,
        model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash',
        baseUrl: hostOf(process.env.DEEPSEEK_BASE_URL),
      },
    },
    notifications: statuses,
    providersProbedAt: probedAt,
  });
});

/** 只回显主机名，避免任何凭证或完整 URL 进入浏览器 */
function hostOf(raw: string | undefined): string {
  if (!raw) return '';
  try {
    return new URL(raw).host;
  } catch {
    return '';
  }
}

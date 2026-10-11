import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';

export const healthRoutes = new Hono();

/**
 * 健康检查：供 systemd/外部探活使用。
 * 数据库不可用时返回 503，便于监控发现问题。
 */
healthRoutes.get('/', async (c) => {
  const startedAt = Date.now();
  try {
    await db.execute(sql`select 1`);
    return c.json({
      status: 'ok',
      db: 'up',
      latencyMs: Date.now() - startedAt,
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      time: new Date().toISOString(),
    });
  } catch (err) {
    return c.json(
      {
        status: 'degraded',
        db: 'down',
        error: (err as Error).message,
      },
      503,
    );
  }
});

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { config } from './config';
import { pool } from './db/client';
import { cleanupExpiredSessions } from './lib/session';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';
import { statusRoutes } from './routes/status';

const app = new Hono();

app.use('*', logger());
app.use(
  '*',
  secureHeaders({
    xFrameOptions: 'DENY',
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'same-origin',
    strictTransportSecurity: config.secureCookies ? 'max-age=31536000; includeSubDomains' : undefined,
  }),
);

const api = new Hono();
api.route('/health', healthRoutes);
api.route('/auth', authRoutes);
api.route('/status', statusRoutes);

// API 一律不缓存，防止代理缓存登录态响应
api.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

app.route('/api', api);

app.notFound((c) => c.json({ error: 'not_found', message: '接口不存在' }, 404));

app.onError((err, c) => {
  console.error('[api] 未捕获异常:', err);
  return c.json({ error: 'internal_error', message: '服务器内部错误' }, 500);
});

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`[api] Life OS API 已启动 http://${config.host}:${info.port} (TZ=${config.timezone})`);
});

// 每小时清理过期会话，避免 sessions 表无限增长
const sessionSweeper = setInterval(
  () => {
    cleanupExpiredSessions()
      .then((n) => {
        if (n > 0) console.log(`[api] 已清理 ${n} 条过期会话`);
      })
      .catch((err) => console.error('[api] 会话清理失败:', err.message));
  },
  60 * 60 * 1000,
);
sessionSweeper.unref();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[api] 收到 ${signal}，正在优雅退出…`);

  const forceExit = setTimeout(() => {
    console.error('[api] 退出超时，强制结束');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(async () => {
    await pool.end().catch(() => undefined);
    console.log('[api] 已退出');
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

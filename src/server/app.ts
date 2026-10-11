/**
 * Hono 应用装配（无副作用，便于测试）。
 *
 * 与进程入口分离：index.ts 负责监听端口、信号与定时清理；
 * 这里只负责中间件与路由，因此测试可以直接 app.request() 打真实路由，
 * 无需启动服务器、也无需使用任何生产凭据。
 */
import { Hono, type Context } from 'hono';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { config } from './config';
import { authRoutes } from './routes/auth';
import { calendarRoutes } from './routes/calendar';
import { eventRoutes } from './routes/events';
import { healthRoutes } from './routes/health';
import { notificationRoutes } from './routes/notifications';
import { statusRoutes } from './routes/status';
import { taskRoutes } from './routes/tasks';

export function createApp(): Hono {
  const app = new Hono();

  app.use('*', logger());
  app.use(
    '*',
    secureHeaders({
      xFrameOptions: 'DENY',
      xContentTypeOptions: 'nosniff',
      referrerPolicy: 'same-origin',
      strictTransportSecurity: config.secureCookies
        ? 'max-age=31536000; includeSubDomains'
        : undefined,
    }),
  );

  const api = new Hono();

  /**
   * API 一律不缓存，防止代理或浏览器缓存登录态响应。
   *
   * 必须注册在路由**之前**：Hono 按注册顺序匹配，注册在路由之后的中间件
   * 不会被已匹配的路由执行（这是曾经的真实缺陷）。
   * 前后各写一次：前一次保证未捕获异常/404 也带上，后一次覆盖处理器自有设置。
   */
  api.use('*', async (c, next) => {
    applyNoStore(c);
    await next();
    applyNoStore(c);
  });

  api.route('/health', healthRoutes);
  api.route('/auth', authRoutes);
  api.route('/status', statusRoutes);
  api.route('/notifications', notificationRoutes);
  api.route('/events', eventRoutes);
  api.route('/tasks', taskRoutes);
  api.route('/calendar', calendarRoutes);

  app.route('/api', api);

  app.notFound((c) => c.json({ error: 'not_found', message: '接口不存在' }, 404));

  app.onError((err, c) => {
    console.error('[api] 未捕获异常:', err);
    return c.json({ error: 'internal_error', message: '服务器内部错误' }, 500);
  });

  return app;
}

function applyNoStore(c: Context): void {
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');
}

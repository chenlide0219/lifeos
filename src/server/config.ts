import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少必需的环境变量：${name}`);
  return value;
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 8890),
  sessionSecret: process.env.SESSION_SECRET ?? '',
  /** 用户时区：所有“本地时间”换算以此为准 */
  timezone: process.env.TZ ?? 'Asia/Shanghai',
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS ?? 30),
  /** 生产走 HTTPS，Cookie 必须 Secure；本地 HTTP 调试可设为 0 */
  secureCookies: process.env.COOKIE_SECURE !== '0',
} as const;

if (!config.databaseUrl.startsWith('postgres')) {
  throw new Error('DATABASE_URL 必须是 PostgreSQL 连接串');
}

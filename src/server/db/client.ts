import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { config } from '../config';
import * as schema from './schema';

/**
 * 连接池刻意开小：VPS 仅 1GB 内存，PostgreSQL 每个连接约占 10-40MB。
 * 单管理员应用并发极低，5 个连接足够。
 */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'lifeos',
});

pool.on('error', (err) => {
  console.error('[db] 空闲连接异常:', err.message);
});

export const db = drizzle(pool, { schema });
export { schema };

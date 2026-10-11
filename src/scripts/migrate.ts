import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from '../server/db/client';
import { settings } from '../server/db/schema';

async function seedDefaults(): Promise<void> {
  await db
    .insert(settings)
    .values([
      { key: 'timezone', value: { value: process.env.TZ ?? 'Asia/Shanghai' } },
      { key: 'calendar.defaultView', value: { value: 'month' } },
      { key: 'theme', value: { value: 'system' } },
    ])
    .onConflictDoNothing();
  console.log('[migrate] 默认设置已就绪');
}

async function main(): Promise<void> {
  console.log('[migrate] 开始执行数据库迁移…');
  await migrate(db, { migrationsFolder: 'drizzle' });
  console.log('[migrate] 迁移完成');
  await seedDefaults();
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('[migrate] 迁移失败:', err);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });

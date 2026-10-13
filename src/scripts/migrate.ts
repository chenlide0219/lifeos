import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from '../server/db/client';

async function main(): Promise<void> {
  console.log('[migrate] 开始执行数据库迁移…');
  await migrate(db, { migrationsFolder: 'drizzle' });
  console.log('[migrate] 迁移完成');
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

/**
 * 归属作用域的统一约定（多用户数据隔离）。
 *
 * ## 为什么需要这个文件
 *
 * 多用户上线后，业务数据按账号**完全隔离**。约束来自两侧：
 * - 数据库侧：每张业务表都有 `user_id NOT NULL`，子表还用**复合外键**保证
 *   "我的订阅和我的账号是同一个人"（见 db/schema.ts）。
 * - 应用侧：每一条读、写、删都必须限定在当前账号内。
 *
 * 数据库能挡住"写错归属"，但**挡不住"查询忘了过滤"**——那正是最容易发生、
 * 后果最严重的跨用户泄露。因此这里把"只属于该账号"这个条件收敛成一个**唯一写法**，
 * 好处是它变得可审计：
 *
 *     grep -c 'ownedBy(' src/server/routes/*.ts
 *
 * 任何对上述表的 `select / update / delete` 都必须出现 `ownedBy(...)`；
 * 任何 `insert` 都必须显式写入 `userId`（列是 NOT NULL，漏了会立刻编译失败）。
 *
 * ## 使用方式
 *
 * ```ts
 * const userId = c.get('user').id;
 * const row = (await db.select().from(events)
 *   .where(and(eq(events.id, id), ownedBy(events, userId)))
 *   .limit(1))[0];
 * ```
 *
 * 注意两点：
 * 1. **不要用 403 区分"别人的资源"与"不存在"**：两者都返回同一个 404，
 *    否则等于向调用者确认"这个 id 是存在的"，泄露了别人的数据规模与 id。
 * 2. 更新/删除同样要带 `ownedBy`，不能只靠"先查一遍再按 id 改"——
 *    两步之间的竞态与"忘了查"都是真实发生过的缺陷模式。
 */
import { eq } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/** 任何"属于某个账号"的表都必须有这一列 */
export type OwnedTable = { userId: AnyPgColumn };

/**
 * 「只属于该账号」的过滤条件。
 *
 * 刻意做成函数而不是常量：它必须在每个查询里**就地出现**，
 * 这样漏写的地方在 diff 与 grep 里都是可见的。
 */
export function ownedBy(table: OwnedTable, userId: number): SQL {
  return eq(table.userId, userId);
}

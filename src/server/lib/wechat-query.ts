/**
 * 查询执行（PRD 3.5、16.1-3 已确认口径）。
 *
 * 已确认的默认口径（不得自行改动）：
 *   - **今日** = 今天到期 **+ 逾期未完成**，逾期单独分组并标注「逾期」；
 *   - **不含**已完成 / 已取消；
 *   - **无日期待办**不属于今日，也不属于未来七天，末尾单独分组；
 *   - **跨天事件按开始日归属**（与 Web 日历一致，不按重叠计入）；
 *   - **未来七天含今天**（今天起算共七天）。
 *
 * 查询结果**全部来自数据库**，模型只负责判断查询意图与范围，
 * 不得由模型生成事项内容（PRD 3.5）。
 */
import { and, asc, eq, gte, isNotNull, isNull, lte } from 'drizzle-orm';
import { db } from '../db/client';
import { events, tasks } from '../db/schema';
import { config } from '../config';
import { ownedBy } from './scope';
import { addDays, instantToDateString, instantToTimeString, zonedToInstant } from './time';
import { formatQueryReply, type GroupedQueryItems, type QueryItem } from './wechat-reply';

export type { QuerySpec } from './wechat-model';
import type { QuerySpec } from './wechat-model';

export type QueryRange = {
  /** 起始日历日期（含） */
  fromDate: string;
  /** 结束日历日期（含） */
  toDate: string;
  /** 是否把「今日」解释为含逾期（只有 today 预设为真） */
  includeOverdue: boolean;
  /** 展示用的范围标题 */
  title: string;
};

/**
 * 把查询预设换算成日历区间。
 * `date` 预设优先使用模型给出的日期；缺失时退回今天，避免空查询。
 */
export function resolveRange(spec: QuerySpec, now: Date, timeZone: string = config.timezone): QueryRange {
  const today = instantToDateString(now, timeZone);
  switch (spec.preset) {
    case 'today':
      return { fromDate: today, toDate: today, includeOverdue: true, title: `${today} 今天` };
    case 'tomorrow': {
      const tomorrow = addDays(today, 1);
      return { fromDate: tomorrow, toDate: tomorrow, includeOverdue: false, title: `${tomorrow} 明天` };
    }
    case 'week': {
      // 含今天，共七天
      const end = addDays(today, 6);
      return { fromDate: today, toDate: end, includeOverdue: true, title: `${today} 起七天` };
    }
    case 'date': {
      const target = spec.date && /^\d{4}-\d{2}-\d{2}$/.test(spec.date) ? spec.date : today;
      return { fromDate: target, toDate: target, includeOverdue: false, title: target };
    }
    default:
      return { fromDate: today, toDate: today, includeOverdue: true, title: `${today} 今天` };
  }
}

export type QueryData = {
  range: QueryRange;
  groups: GroupedQueryItems;
  total: number;
};

/**
 * 读取查询数据。
 *
 * 事件按 `start_at` 落在区间内筛选——**按开始日归属**，因此跨天事件
 * 只在开始那天出现（PRD 16.1-3）。
 *
 * `userId` 是发消息那个人（处理器从 inbox 行传下来）。**本函数里每一条
 * 对 events / tasks 的查询都必须带 `ownedBy(表, userId)`**：
 * 微信里问"今天有什么"，返回的只能是问话人自己的日程——
 * 这类"查询忘了过滤"是跨用户泄露里最容易发生、也最严重的一种。
 */
export async function loadQueryData(userId: number, spec: QuerySpec, now: Date): Promise<QueryData> {
  const range = resolveRange(spec, now);

  // 区间端点换算为绝对时刻：本地 00:00 到 次日 00:00（不含）
  const [fy, fm, fd] = range.fromDate.split('-').map(Number);
  const [ty, tm, td] = range.toDate.split('-').map(Number);
  const fromInstant = zonedToInstant(fy!, fm!, fd!, 0, 0);
  const toInstant = zonedToInstant(ty!, tm!, td!, 0, 0);
  const dayAfterTo = new Date(toInstant.getTime() + 86_400_000);

  const groups: { label: string; items: QueryItem[] }[] = [];

  if (spec.filter === 'all' || spec.filter === 'event') {
    const eventRows = await db
      .select({
        id: events.id,
        title: events.title,
        startAt: events.startAt,
        endAt: events.endAt,
        location: events.location,
        status: events.status,
      })
      .from(events)
      .where(
        and(
          eq(events.status, 'active'),
          gte(events.startAt, fromInstant),
          lte(events.startAt, dayAfterTo),
          ownedBy(events, userId),
        ),
      )
      .orderBy(asc(events.startAt))
      .limit(200);

    const items = eventRows
      .filter((row) => row.startAt.getTime() < dayAfterTo.getTime())
      .map<QueryItem>((row) => ({
        type: 'event',
        title: row.title,
        when: `${instantToDateString(row.startAt)} ${instantToTimeString(row.startAt)}`,
        detail: row.location ?? null,
      }));
    if (items.length > 0) groups.push({ label: '日程', items });
  }

  if (spec.filter === 'all' || spec.filter === 'task') {
    // 逾期：截止日早于区间起点且仍未完成（只在 includeOverdue 时单独成组）
    if (range.includeOverdue) {
      const overdue = await db
        .select({
          id: tasks.id,
          title: tasks.title,
          dueDate: tasks.dueDate,
          dueTime: tasks.dueTime,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.status, 'todo'),
            isNotNull(tasks.dueDate),
            lte(tasks.dueDate, addDays(range.fromDate, -1)),
            ownedBy(tasks, userId),
          ),
        )
        .orderBy(asc(tasks.dueDate))
        .limit(100);

      if (overdue.length > 0) {
        groups.push({
          label: '逾期',
          items: overdue.map<QueryItem>((row) => ({
            type: 'task',
            title: row.title,
            when: row.dueDate!,
            detail: '逾期未完成',
          })),
        });
      }
    }

    const dueInRange = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        dueDate: tasks.dueDate,
        dueTime: tasks.dueTime,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.status, 'todo'),
          isNotNull(tasks.dueDate),
          gte(tasks.dueDate, range.fromDate),
          lte(tasks.dueDate, range.toDate),
          ownedBy(tasks, userId),
        ),
      )
      .orderBy(asc(tasks.dueDate), asc(tasks.dueTime))
      .limit(200);

    if (dueInRange.length > 0) {
      groups.push({
        label: range.fromDate === range.toDate ? '当天待办' : '待办',
        items: dueInRange.map<QueryItem>((row) => ({
          type: 'task',
          title: row.title,
          when: row.dueTime ? `${row.dueDate} ${row.dueTime.slice(0, 5)}` : `${row.dueDate} 全天`,
          detail: null,
        })),
      });
    }
  }

  // 无日期待办：不属于任何一天，末尾单独分组（PRD 16.1-3）
  if (spec.filter === 'all' || spec.filter === 'task') {
    const undated = await db
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(and(eq(tasks.status, 'todo'), isNull(tasks.dueDate), ownedBy(tasks, userId)))
      .orderBy(asc(tasks.createdAt))
      .limit(100);

    if (undated.length > 0) {
      groups.push({
        label: '无日期待办（收件箱）',
        items: undated.map<QueryItem>((row) => ({
          type: 'task',
          title: row.title,
          when: '未排期',
          detail: null,
        })),
      });
    }
  }

  const grouped: GroupedQueryItems = { groups };
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return { range, groups: grouped, total };
}

/** 组装最终回复：遵守 8 条 / 600 字与截断标注（PRD 16.2） */
export async function runQuery(userId: number, spec: QuerySpec, now: Date, draftNotice: string | null) {
  const data = await loadQueryData(userId, spec, now);
  const result = formatQueryReply({
    title: `📅 ${data.range.title}`,
    groups: data.groups,
    emptyText: '这个范围内没有安排。',
  });

  const body = draftNotice ? `${result.body}\n\n${draftNotice}` : result.body;
  return { ...result, body, range: data.range };
}

/** 供测试与诊断：区间信息里的日期数量 */
export function rangeDayCount(range: QueryRange): number {
  const [fy, fm, fd] = range.fromDate.split('-').map(Number);
  const [ty, tm, td] = range.toDate.split('-').map(Number);
  const from = Date.UTC(fy!, fm! - 1, fd!);
  const to = Date.UTC(ty!, tm! - 1, td!);
  return Math.round((to - from) / 86_400_000) + 1;
}

export { config };

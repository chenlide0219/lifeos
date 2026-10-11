import { Hono } from 'hono';
import { and, eq, gte, isNotNull, lte, ne } from 'drizzle-orm';
import { db } from '../db/client';
import { events, tasks } from '../db/schema';
import { instantToDateString, instantToTimeString } from '../lib/time';
import { ValidationError, optQueryInstant } from '../lib/validate';
import { requireAuth, type AppEnv } from '../middleware/auth';
import { guard } from './events';

export const calendarRoutes = new Hono<AppEnv>();

export type CalendarItem = {
  /** event | task | subscription */
  type: 'event' | 'task' | 'subscription';
  id: string;
  title: string;
  /** 绝对时刻；全天待办没有具体时刻时为 null */
  start: string;
  end: string | null;
  /** 该时区下的日历日期，便于按天分组 */
  date: string;
  time: string | null;
  allDay: boolean;
  status: string;
  /** 已取消/已完成等，界面据此弱化显示 */
  inactive: boolean;
  meta: Record<string, unknown>;
};

/**
 * 统一日历读视图（PRD FR-04）。
 *
 * 关键约束：聚合的是**读视图**，不把订阅事项复制成 Event，
 * 避免同一事实存在两份数据而互相不一致。
 */
calendarRoutes.get('/', requireAuth, async (c) =>
  guard(c, async () => {
    const now = Date.now();
    const from = optQueryInstant(c.req.query('from'), 'from') ?? new Date(now - 45 * 86_400_000);
    const to = optQueryInstant(c.req.query('to'), 'to') ?? new Date(now + 45 * 86_400_000);

    if (to.getTime() <= from.getTime()) {
      throw new ValidationError('to 必须晚于 from');
    }
    // 限制单次查询跨度，避免天真的客户端把整库拉走
    if (to.getTime() - from.getTime() > 400 * 86_400_000) {
      throw new ValidationError('查询跨度不能超过 400 天');
    }

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
      .where(and(gte(events.startAt, from), lte(events.startAt, to)))
      .orderBy(events.startAt)
      .limit(1000);

    // 有日期的待办才进日历；无日期的留在收件箱
    const taskRows = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        dueDate: tasks.dueDate,
        dueTime: tasks.dueTime,
        status: tasks.status,
      })
      .from(tasks)
      .where(and(isNotNull(tasks.dueDate), ne(tasks.status, 'cancelled')))
      .orderBy(tasks.dueDate)
      .limit(1000);

    const fromDate = instantToDateString(from);
    const toDate = instantToDateString(to);

    const items: CalendarItem[] = [];

    for (const e of eventRows) {
      items.push({
        type: 'event',
        id: e.id,
        title: e.title,
        start: e.startAt.toISOString(),
        end: e.endAt ? e.endAt.toISOString() : null,
        date: instantToDateString(e.startAt),
        time: instantToTimeString(e.startAt),
        allDay: false,
        status: e.status,
        inactive: e.status !== 'active',
        meta: { location: e.location },
      });
    }

    for (const t of taskRows) {
      // 待办的日期是“日历日期”，按本地日期直接过滤，不做 UTC 换算
      if (!t.dueDate || t.dueDate < fromDate || t.dueDate > toDate) continue;
      const hasTime = Boolean(t.dueTime);
      items.push({
        type: 'task',
        id: t.id,
        title: t.title,
        // 有具体时刻时按该时区的墙上时间换算成绝对时刻；全天则只给日期
        start: hasTime ? `${t.dueDate}T${t.dueTime}` : `${t.dueDate}T00:00:00`,
        end: null,
        date: t.dueDate,
        time: hasTime ? t.dueTime!.slice(0, 5) : null,
        allDay: !hasTime,
        status: t.status,
        inactive: t.status === 'done' || t.status === 'cancelled',
        meta: { completed: t.status === 'done' },
      });
    }

    // 订阅生成的续费/到期条目在阶段 4 接入，届时同样只做读视图聚合，
    // 不复制成 Event —— 以免同一事实存在两份数据。

    items.sort((a, b) => (a.date === b.date ? a.start.localeCompare(b.start) : a.date.localeCompare(b.date)));

    const byDate: Record<string, number> = {};
    for (const item of items) byDate[item.date] = (byDate[item.date] ?? 0) + 1;

    return c.json({
      items,
      counts: byDate,
      range: { from: from.toISOString(), to: to.toISOString(), fromDate, toDate },
      types: { event: 'event', task: 'task', subscription: 'subscription' },
    });
  }),
);

/** 仪表盘：今日待办 + 未来 7 天概要 */
calendarRoutes.get('/overview', requireAuth, async (c) =>
  guard(c, async () => {
    const now = new Date();
    const today = instantToDateString(now);
    const horizon = new Date(now.getTime() + 7 * 86_400_000);
    const horizonDate = instantToDateString(horizon);

    const upcomingEvents = await db
      .select({
        id: events.id,
        title: events.title,
        startAt: events.startAt,
        location: events.location,
      })
      .from(events)
      .where(and(eq(events.status, 'active'), gte(events.startAt, now), lte(events.startAt, horizon)))
      .orderBy(events.startAt)
      .limit(20);

    // 今日待办 = 今天到期 + 已逾期未完成
    const dueToday = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        dueDate: tasks.dueDate,
        dueTime: tasks.dueTime,
      })
      .from(tasks)
      .where(and(eq(tasks.status, 'todo'), isNotNull(tasks.dueDate), lte(tasks.dueDate, today)))
      .orderBy(tasks.dueDate, tasks.dueTime)
      .limit(20);

    return c.json({
      today,
      horizonDate,
      events: upcomingEvents.map((e) => ({
        id: e.id,
        title: e.title,
        startAt: e.startAt.toISOString(),
        date: instantToDateString(e.startAt),
        time: instantToTimeString(e.startAt),
        location: e.location,
      })),
      tasksDueToday: dueToday,
      tasksDueTodayCount: dueToday.length,
    });
  }),
);

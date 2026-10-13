import { Hono } from 'hono';
import { and, eq, gte, isNotNull, lte, ne } from 'drizzle-orm';
import { db } from '../db/client';
import { events, expectedBills, subscriptions, tasks } from '../db/schema';
import { ownedBy } from '../lib/scope';
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

    const userId = c.get('user').id;

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
      .where(and(gte(events.startAt, from), lte(events.startAt, to), ownedBy(events, userId)))
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
      .where(and(isNotNull(tasks.dueDate), ne(tasks.status, 'cancelled'), ownedBy(tasks, userId)))
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

    // 订阅生成的续费/到期条目。
    // 关键：这里聚合的是**读视图**，不把订阅事项复制成 Event ——
    // 同一事实存在两份数据必然不一致（PRD FR-04）。
    const subscriptionItems = await db
      .select({
        id: expectedBills.id,
        subscriptionId: expectedBills.subscriptionId,
        name: subscriptions.name,
        plannedDate: expectedBills.plannedDate,
        amount: expectedBills.amount,
        currency: expectedBills.currency,
        billStatus: expectedBills.status,
        autoRenew: subscriptions.autoRenew,
        serviceEndDate: subscriptions.serviceEndDate,
        subStatus: subscriptions.status,
      })
      .from(expectedBills)
      // 联表的每一侧都要按当前账号过滤：账单属于我，它关联的订阅也必须属于我
      .innerJoin(
        subscriptions,
        and(eq(subscriptions.id, expectedBills.subscriptionId), ownedBy(subscriptions, userId)),
      )
      .where(
        and(
          gte(expectedBills.plannedDate, fromDate),
          lte(expectedBills.plannedDate, toDate),
          ownedBy(expectedBills, userId),
          // 已取消的账单不进日历；已确认/已跳过的仍显示（历史事实）
          ne(expectedBills.status, 'cancelled'),
        ),
      )
      .orderBy(expectedBills.plannedDate)
      .limit(500);

    for (const s of subscriptionItems) {
      items.push({
        type: 'subscription',
        id: s.id,
        title: `${s.name} 续费`,
        start: `${s.plannedDate}T00:00:00`,
        end: null,
        date: s.plannedDate,
        time: null,
        // 扣费日是"日历日期"，不是某个时刻，因此按全天处理，不当作 UTC 午夜
        allDay: true,
        status: s.billStatus,
        inactive: s.billStatus !== 'expected',
        meta: {
          subscriptionId: s.subscriptionId,
          amount: s.amount,
          currency: s.currency,
          // 自动续费关闭时给出到期提示，避免误以为还会自动扣费
          autoRenew: s.autoRenew,
          note: s.autoRenew ? '预计扣费' : '已关闭自动续费，仅为预计扣费日',
        },
      });
    }

    // 服务到期日本身也是重要日期（尤其是已关闭自动续费的订阅）
    const endingSubs = await db
      .select({
        id: subscriptions.id,
        name: subscriptions.name,
        serviceEndDate: subscriptions.serviceEndDate,
        autoRenew: subscriptions.autoRenew,
      })
      .from(subscriptions)
      .where(
        and(
          isNotNull(subscriptions.serviceEndDate),
          gte(subscriptions.serviceEndDate, fromDate),
          lte(subscriptions.serviceEndDate, toDate),
          ne(subscriptions.status, 'ended'),
          ownedBy(subscriptions, userId),
        ),
      )
      .limit(200);

    for (const s of endingSubs) {
      items.push({
        type: 'subscription',
        id: `end:${s.id}`,
        title: `${s.name} ${s.autoRenew ? '本期到期' : '服务到期'}`,
        start: `${s.serviceEndDate}T00:00:00`,
        end: null,
        date: s.serviceEndDate!,
        time: null,
        allDay: true,
        status: 'service_end',
        inactive: false,
        meta: { subscriptionId: s.id, autoRenew: s.autoRenew, note: '服务到期日' },
      });
    }

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

/**
 * 仪表盘：今日待办（含逾期未完成，不含无日期待办——它们留在待办页收件箱）。
 *
 * 未来一周的安排直接看日历的周视图，此处不再重复返回事件；
 * 订阅的「即将扣费」由 /api/subscriptions/summary 提供。
 */
calendarRoutes.get('/overview', requireAuth, async (c) =>
  guard(c, async () => {
    const now = new Date();
    const today = instantToDateString(now);
    const userId = c.get('user').id;

    // 今日待办 = 今天到期 + 已逾期未完成；无截止日期的待办不属于任何一天，不在这里
    const dueToday = await db
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
          lte(tasks.dueDate, today),
          ownedBy(tasks, userId),
        ),
      )
      .orderBy(tasks.dueDate, tasks.dueTime)
      .limit(20);

    return c.json({
      today,
      tasksDueToday: dueToday,
      tasksDueTodayCount: dueToday.length,
    });
  }),
);

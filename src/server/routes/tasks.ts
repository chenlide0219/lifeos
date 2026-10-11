import { Hono } from 'hono';
import { and, asc, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { tasks } from '../db/schema';
import {
  listSubjectJobs,
  purgeSubjectNotifications,
  rebuildTaskNotifications,
  upsertRule,
} from '../lib/scheduling';
import { todayInTz } from '../lib/time';
import {
  optBoolean,
  optDateString,
  optOffsets,
  optString,
  optTimeString,
  parseUuid,
  reqString,
} from '../lib/validate';
import { requireAuth, type AppEnv } from '../middleware/auth';
import { guard } from './events';

export const taskRoutes = new Hono<AppEnv>();

const SELECT_FIELDS = {
  id: tasks.id,
  title: tasks.title,
  dueDate: tasks.dueDate,
  dueTime: tasks.dueTime,
  status: tasks.status,
  completedAt: tasks.completedAt,
  note: tasks.note,
  source: tasks.source,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
};

const VIEWS = ['inbox', 'today', 'upcoming', 'done'] as const;
type View = (typeof VIEWS)[number];

taskRoutes.get('/', requireAuth, async (c) =>
  guard(c, async () => {
    const viewParam = c.req.query('view') ?? 'today';
    const view: View = (VIEWS as readonly string[]).includes(viewParam) ? (viewParam as View) : 'today';
    const today = todayInTz();

    // 「今天」= 今天到期 + 已逾期但仍未完成；「计划中」= 未来到期；
    // 「收件箱」= 没有截止日期的待办；「已完成」= done
    const conditions = {
      inbox: and(eq(tasks.status, 'todo'), isNull(tasks.dueDate)),
      today: and(
        eq(tasks.status, 'todo'),
        or(isNull(tasks.dueDate), lte(tasks.dueDate, today)),
      ),
      upcoming: and(eq(tasks.status, 'todo'), sql`${tasks.dueDate} > ${today}`),
      done: eq(tasks.status, 'done'),
    }[view];

    const rows = await db
      .select(SELECT_FIELDS)
      .from(tasks)
      .where(conditions)
      .orderBy(
        // 注意：不能用 asc(sql`... NULLS LAST`) —— 那会生成 "NULLS LAST asc" 的非法顺序，
        // 方向与 NULLS 位置必须写在同一个 sql 片段里。
        view === 'done' ? desc(tasks.completedAt) : sql`${tasks.dueDate} asc nulls last`,
        asc(tasks.createdAt),
      )
      .limit(300);

    return c.json({ tasks: rows, view, today });
  }),
);

taskRoutes.get('/counts', requireAuth, async (c) =>
  guard(c, async () => {
    const today = todayInTz();
    const rows = await db
      .select({
        inbox: sql<number>`count(*) filter (where ${tasks.status} = 'todo' and ${tasks.dueDate} is null)::int`,
        today: sql<number>`count(*) filter (where ${tasks.status} = 'todo' and ${tasks.dueDate} is not null and ${tasks.dueDate} <= ${today})::int`,
        upcoming: sql<number>`count(*) filter (where ${tasks.status} = 'todo' and ${tasks.dueDate} > ${today})::int`,
        done: sql<number>`count(*) filter (where ${tasks.status} = 'done')::int`,
      })
      .from(tasks);

    return c.json({ counts: rows[0] ?? { inbox: 0, today: 0, upcoming: 0, done: 0 }, today });
  }),
);

taskRoutes.get('/:id', requireAuth, async (c) =>
  guard(c, async () => {
    const id = parseUuid(c.req.param('id'), '待办 ID');
    const [row] = await db.select(SELECT_FIELDS).from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!row) return c.json({ error: 'not_found', message: '待办不存在' }, 404);
    const reminders = await listSubjectJobs('task', id);
    return c.json({ task: row, reminders });
  }),
);

taskRoutes.post('/', requireAuth, async (c) =>
  guard(c, async () => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: 'invalid_request', message: '请求体必须是 JSON' }, 400);

    const title = reqString(body.title, '标题');
    const dueDate = optDateString(body.dueDate, '截止日期');
    const dueTime = optTimeString(body.dueTime, '截止时刻');
    const reminderEnabled = optBoolean(body.reminderEnabled, '提醒开关', false);
    const offsets = optOffsets(body.reminderOffsets, '提醒提前量');

    // PRD FR-02：要精确到分钟提醒，必须补充具体时间
    if (offsets.length > 0 && (!dueDate || !dueTime)) {
      return c.json(
        { error: 'invalid_request', message: '设置精确提醒需要同时填写截止日期和具体时刻' },
        400,
      );
    }
    if (dueTime && !dueDate) {
      return c.json({ error: 'invalid_request', message: '填写具体时刻时必须同时填写截止日期' }, 400);
    }

    const [created] = await db
      .insert(tasks)
      .values({
        title,
        dueDate,
        dueTime,
        note: optString(body.note, '备注'),
        source: body.source === 'voice' ? 'voice' : 'manual',
      })
      .returning(SELECT_FIELDS);

    if (dueDate) {
      await upsertRule('task', created!.id, { enabled: reminderEnabled, offsetsMinutes: offsets });
    }
    const reminder = await rebuildTaskNotifications(created!.id);

    return c.json({ task: created, reminder }, 201);
  }),
);

taskRoutes.patch('/:id', requireAuth, async (c) =>
  guard(c, async () => {
    const id = parseUuid(c.req.param('id'), '待办 ID');
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: 'invalid_request', message: '请求体必须是 JSON' }, 400);

    const [current] = await db.select(SELECT_FIELDS).from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!current) return c.json({ error: 'not_found', message: '待办不存在' }, 404);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.title !== undefined) patch.title = reqString(body.title, '标题');
    if (body.dueDate !== undefined) patch.dueDate = optDateString(body.dueDate, '截止日期');
    if (body.dueTime !== undefined) patch.dueTime = optTimeString(body.dueTime, '截止时刻');
    if (body.note !== undefined) patch.note = optString(body.note, '备注');

    const nextDate = body.dueDate !== undefined ? (patch.dueDate as string | null) : current.dueDate;
    const nextTime = body.dueTime !== undefined ? (patch.dueTime as string | null) : current.dueTime;
    if (nextTime && !nextDate) {
      return c.json({ error: 'invalid_request', message: '填写具体时刻时必须同时填写截止日期' }, 400);
    }

    const [updated] = await db.update(tasks).set(patch).where(eq(tasks.id, id)).returning(SELECT_FIELDS);

    if (body.reminderEnabled !== undefined || body.reminderOffsets !== undefined) {
      const offsets = optOffsets(body.reminderOffsets, '提醒提前量');
      if (offsets.length > 0 && (!nextDate || !nextTime)) {
        return c.json(
          { error: 'invalid_request', message: '设置精确提醒需要同时填写截止日期和具体时刻' },
          400,
        );
      }
      await upsertRule('task', id, {
        enabled: optBoolean(body.reminderEnabled, '提醒开关', false),
        offsetsMinutes: offsets,
      });
    }

    // 截止时间或提醒变化后重建：旧提醒先失效
    const reminder = await rebuildTaskNotifications(id);

    return c.json({ task: updated, reminder });
  }),
);

taskRoutes.post('/:id/complete', requireAuth, async (c) =>
  guard(c, async () => {
    const id = parseUuid(c.req.param('id'), '待办 ID');
    const [updated] = await db
      .update(tasks)
      .set({ status: 'done', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning(SELECT_FIELDS);

    if (!updated) return c.json({ error: 'not_found', message: '待办不存在' }, 404);

    // 完成后不再提醒
    const reminder = await rebuildTaskNotifications(id);
    return c.json({ task: updated, reminder });
  }),
);

taskRoutes.post('/:id/reopen', requireAuth, async (c) =>
  guard(c, async () => {
    const id = parseUuid(c.req.param('id'), '待办 ID');
    const [updated] = await db
      .update(tasks)
      .set({ status: 'todo', completedAt: null, updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning(SELECT_FIELDS);

    if (!updated) return c.json({ error: 'not_found', message: '待办不存在' }, 404);
    const reminder = await rebuildTaskNotifications(id);
    return c.json({ task: updated, reminder });
  }),
);

taskRoutes.post('/:id/cancel', requireAuth, async (c) =>
  guard(c, async () => {
    const id = parseUuid(c.req.param('id'), '待办 ID');
    const [updated] = await db
      .update(tasks)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning(SELECT_FIELDS);

    if (!updated) return c.json({ error: 'not_found', message: '待办不存在' }, 404);
    const reminder = await rebuildTaskNotifications(id);
    return c.json({ task: updated, reminder });
  }),
);

taskRoutes.delete('/:id', requireAuth, async (c) =>
  guard(c, async () => {
    const id = parseUuid(c.req.param('id'), '待办 ID');
    const [existing] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!existing) return c.json({ error: 'not_found', message: '待办不存在' }, 404);

    await purgeSubjectNotifications('task', id);
    await db.delete(tasks).where(eq(tasks.id, id));
    return c.json({ ok: true });
  }),
);

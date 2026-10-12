import { Hono, type Context } from 'hono';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { db } from '../db/client';
import { events } from '../db/schema';
import {
  getSubjectRule,
  listSubjectJobs,
  purgeSubjectNotifications,
  rebuildEventNotifications,
  upsertEventRule,
} from '../lib/scheduling';
import {
  ValidationError,
  optBoolean,
  optInstant,
  optOffsets,
  optQueryInstant,
  optString,
  parseUuid,
  reqInstant,
  reqString,
} from '../lib/validate';
import { requireAuth, type AppEnv } from '../middleware/auth';

export const eventRoutes = new Hono<AppEnv>();

/** 统一的参数错误处理：ValidationError → 400，其余继续抛出 */
export async function guard(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: 'invalid_request', message: err.message }, 400);
    }
    throw err;
  }
}

const SELECT_FIELDS = {
  id: events.id,
  title: events.title,
  startAt: events.startAt,
  endAt: events.endAt,
  location: events.location,
  note: events.note,
  status: events.status,
  source: events.source,
  createdAt: events.createdAt,
  updatedAt: events.updatedAt,
};

eventRoutes.get('/', requireAuth, async (c) =>
  guard(c, async () => {
    const from = optQueryInstant(c.req.query('from'), 'from');
    const to = optQueryInstant(c.req.query('to'), 'to');
    const limitText = c.req.query('limit');
    const offsetText = c.req.query('offset');
    const limit = limitText === undefined ? 500 : Number(limitText);
    const offset = offsetText === undefined ? 0 : Number(offsetText);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0) {
      throw new ValidationError('分页参数无效');
    }

    const conditions = [];
    if (from) conditions.push(gte(events.startAt, from));
    if (to) conditions.push(lte(events.startAt, to));

    const rows = await db
      .select(SELECT_FIELDS)
      .from(events)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(events.startAt), asc(events.id))
      .limit(limit + 1)
      .offset(offset);

    return c.json({ events: rows.slice(0, limit), hasMore: rows.length > limit });
  }),
);

eventRoutes.get('/:id', requireAuth, async (c) =>
  guard(c, async () => {
    const id = parseUuid(c.req.param('id'), '事件 ID');
    const [row] = await db.select(SELECT_FIELDS).from(events).where(eq(events.id, id)).limit(1);
    if (!row) return c.json({ error: 'not_found', message: '事件不存在' }, 404);
    const reminders = await listSubjectJobs('event', id);
    // 提醒规则单独返回：编辑表单需要回显已保存的开关与提前量，
    // 否则一次"只是改标题"的编辑会把提醒静默关闭
    const rule = await getSubjectRule('event', id);
    return c.json({ event: row, reminders, rule });
  }),
);

eventRoutes.post('/', requireAuth, async (c) =>
  guard(c, async () => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: 'invalid_request', message: '请求体必须是 JSON' }, 400);

    const title = reqString(body.title, '标题');
    const startAt = reqInstant(body.startAt, '开始时间');
    const endAt = optInstant(body.endAt, '结束时间');
    if (endAt && endAt.getTime() < startAt.getTime()) {
      return c.json({ error: 'invalid_request', message: '结束时间不能早于开始时间' }, 400);
    }

    const reminderEnabled = optBoolean(body.reminderEnabled, '提醒开关', false);
    const offsets = optOffsets(body.reminderOffsets, '提醒提前量');

    const [created] = await db
      .insert(events)
      .values({
        title,
        startAt,
        endAt,
        location: optString(body.location, '地点'),
        note: optString(body.note, '备注'),
        source: body.source === 'voice' ? 'voice' : 'manual',
      })
      .returning(SELECT_FIELDS);

    await upsertEventRule(created!.id, { enabled: reminderEnabled, offsetsMinutes: offsets });
    const reminder = await rebuildEventNotifications(created!.id);

    return c.json({ event: created, reminder }, 201);
  }),
);

eventRoutes.patch('/:id', requireAuth, async (c) =>
  guard(c, async () => {
    const id = parseUuid(c.req.param('id'), '事件 ID');
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: 'invalid_request', message: '请求体必须是 JSON' }, 400);

    const [current] = await db.select(SELECT_FIELDS).from(events).where(eq(events.id, id)).limit(1);
    if (!current) return c.json({ error: 'not_found', message: '事件不存在' }, 404);
    if (current.status !== 'active') {
      return c.json({ error: 'invalid_state', message: '已取消的事件不能再修改' }, 409);
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.title !== undefined) patch.title = reqString(body.title, '标题');
    if (body.startAt !== undefined) patch.startAt = reqInstant(body.startAt, '开始时间');
    if (body.endAt !== undefined) patch.endAt = optInstant(body.endAt, '结束时间');
    if (body.location !== undefined) patch.location = optString(body.location, '地点');
    if (body.note !== undefined) patch.note = optString(body.note, '备注');
    if (typeof body.status === 'string' && ['active', 'cancelled'].includes(body.status)) {
      patch.status = body.status;
    }

    const nextStart = (patch.startAt as Date | undefined) ?? current.startAt;
    const nextEnd = (patch.endAt as Date | null | undefined) ?? current.endAt;
    if (nextEnd && nextEnd.getTime() < nextStart.getTime()) {
      return c.json({ error: 'invalid_request', message: '结束时间不能早于开始时间' }, 400);
    }

    const [updated] = await db.update(events).set(patch).where(eq(events.id, id)).returning(SELECT_FIELDS);

    // 提醒设置变化时更新规则；时间变化时下面的重建会让旧提醒失效
    if (body.reminderEnabled !== undefined || body.reminderOffsets !== undefined) {
      await upsertEventRule(id, {
        enabled: optBoolean(body.reminderEnabled, '提醒开关', false),
        offsetsMinutes: optOffsets(body.reminderOffsets, '提醒提前量'),
      });
    }

    // 无论改的是时间还是提醒设置，都重建一次：旧提醒先取消，再按新时间排
    const reminder = await rebuildEventNotifications(id);

    return c.json({ event: updated, reminder });
  }),
);

eventRoutes.post('/:id/cancel', requireAuth, async (c) =>
  guard(c, async () => {
    const id = parseUuid(c.req.param('id'), '事件 ID');
    const [updated] = await db
      .update(events)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(events.id, id))
      .returning(SELECT_FIELDS);

    if (!updated) return c.json({ error: 'not_found', message: '事件不存在' }, 404);

    // 状态非 active → 重建逻辑会把未发送的提醒全部取消
    const reminder = await rebuildEventNotifications(id);
    return c.json({ event: updated, reminder });
  }),
);

eventRoutes.delete('/:id', requireAuth, async (c) =>
  guard(c, async () => {
    const id = parseUuid(c.req.param('id'), '事件 ID');

    const [existing] = await db.select({ id: events.id }).from(events).where(eq(events.id, id)).limit(1);
    if (!existing) return c.json({ error: 'not_found', message: '事件不存在' }, 404);

    // 先清理通知，再删除主体，避免留下悬挂引用
    await purgeSubjectNotifications('event', id);
    await db.delete(events).where(eq(events.id, id));

    return c.json({ ok: true });
  }),
);

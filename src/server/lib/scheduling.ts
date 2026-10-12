/**
 * 事项变更时的通知任务重调度（PRD FR-02 / FR-07）
 *
 * 必须成立的四条规则：
 *   1. 修改事项时间 → 原提醒失效并重建（新旧不得共存）；
 *   2. 取消 / 删除事项 → 停止未发送的提醒，已发送的记录保留为历史；
 *   3. 创建时已经过去的提醒时间**不补发**（计入 skippedPast 供界面说明）；
 *   4. 待办没有具体时刻时不得排出精确提醒（全天项目）。
 *
 * 实现要点（差量而非"全删重插"）：
 * 幂等键由「主体 + 提前量 + 触发时刻」确定性派生，因此：
 *   - 仍然需要的提醒：**原地复活**（把 cancelled/failed/missed 置回 pending），
 *     而不是先取消再插入 —— 后者会被幂等键唯一约束挡住，导致提醒静默丢失；
 *   - 已发送(sent)的提醒**绝不复活**，否则会重复送达；
 *   - 不再需要的活动提醒：取消。
 */
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { events, notificationJobs, notificationRules, subscriptions, tasks } from '../db/schema';
import { addDays, zonedToInstant } from './time';

export type SubjectType = 'event' | 'task' | 'subscription';

/** 未发送的任务状态：只有这些会被变更操作取消 */
const ACTIVE_JOB_STATUSES = ['pending', 'sending'] as const;

export type RebuildResult = {
  created: number;
  resurrected: number;
  cancelled: number;
  skippedPast: number;
  skippedSent: number;
  ruleEnabled: boolean;
};

/** 单条待排提醒的计划 */
type ReminderPlan = {
  offsetMinutes: number;
  fireAt: Date;
  title: string;
  body: string;
};

export function cancelActiveNotifications(subjectType: SubjectType, subjectId: string): Promise<number> {
  return db
    .update(notificationJobs)
    .set({
      status: 'cancelled',
      leasedUntil: null,
      nextAttemptAt: null,
      lastError: '事项已变更或取消，原提醒不再发送',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(notificationJobs.subjectType, subjectType),
        eq(notificationJobs.subjectId, subjectId),
        inArray(notificationJobs.status, [...ACTIVE_JOB_STATUSES]),
      ),
    )
    .returning({ id: notificationJobs.id })
    .then((rows) => rows.length);
}

export type ReminderRuleInput = { enabled: boolean; offsetsMinutes: number[] };

/** 事件与待办共用同一套规则表，只是主体类型不同 */
export async function upsertRule(
  subjectType: SubjectType,
  subjectId: string,
  input: ReminderRuleInput,
): Promise<string> {
  const offsets = normalizeOffsets(input.offsetsMinutes);

  const [row] = await db
    .insert(notificationRules)
    .values({
      subjectType,
      subjectId,
      channel: 'wechat',
      enabled: input.enabled,
      offsetsMinutes: offsets,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [notificationRules.subjectType, notificationRules.subjectId, notificationRules.channel],
      set: { enabled: input.enabled, offsetsMinutes: offsets, updatedAt: new Date() },
    })
    .returning({ id: notificationRules.id });

  return row!.id;
}

export const upsertEventRule = (eventId: string, input: ReminderRuleInput) =>
  upsertRule('event', eventId, input);

/** 去重、只保留正整数、降序（最早的提醒排前面） */
export function normalizeOffsets(offsets: number[]): number[] {
  const cleaned = [...new Set(offsets.filter((o) => Number.isFinite(o) && o > 0).map((o) => Math.floor(o)))];
  return cleaned.sort((a, b) => b - a);
}

export function offsetLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `提前 ${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `提前 ${minutes / 60} 小时`;
  return `提前 ${minutes} 分钟`;
}

export function buildIdempotencyKey(
  subjectType: SubjectType,
  subjectId: string,
  offsetMinutes: number,
  fireAt: Date,
): string {
  return `${subjectType}:${subjectId}:${offsetMinutes}:${fireAt.toISOString()}`;
}

async function loadRule(subjectType: 'event' | 'task', subjectId: string) {
  const [rule] = await db
    .select({
      id: notificationRules.id,
      enabled: notificationRules.enabled,
      offsets: notificationRules.offsetsMinutes,
    })
    .from(notificationRules)
    .where(
      and(
        eq(notificationRules.subjectType, subjectType),
        eq(notificationRules.subjectId, subjectId),
        eq(notificationRules.channel, 'wechat'),
      ),
    )
    .limit(1);
  return rule;
}

/**
 * 把计划差量应用到数据库：
 *   - 不再需要的活动提醒 → 取消；
 *   - 计划内的提醒 → 插入，或把已存在的非 sent 记录复活为 pending；
 *   - 已发送的记录保持不动（避免重复送达）。
 */
async function applyPlan(
  subjectType: SubjectType,
  subjectId: string,
  ruleId: string,
  plan: ReminderPlan[],
): Promise<{ created: number; resurrected: number; cancelled: number; skippedSent: number }> {
  const keys = plan.map((p) => buildIdempotencyKey(subjectType, subjectId, p.offsetMinutes, p.fireAt));

  // 1) 取消不再需要的活动提醒（幂等键不在计划内的）
  const cancelWhere = [
    eq(notificationJobs.subjectType, subjectType),
    eq(notificationJobs.subjectId, subjectId),
    inArray(notificationJobs.status, [...ACTIVE_JOB_STATUSES]),
  ];
  if (keys.length > 0) cancelWhere.push(notInArray(notificationJobs.idempotencyKey, keys));

  const cancelledRows = await db
    .update(notificationJobs)
    .set({
      status: 'cancelled',
      leasedUntil: null,
      nextAttemptAt: null,
      lastError: '事项已变更，原提醒不再发送',
      updatedAt: new Date(),
    })
    .where(and(...cancelWhere))
    .returning({ id: notificationJobs.id });

  let created = 0;
  let resurrected = 0;
  let skippedSent = 0;

  // 2) 逐条落位
  for (const item of plan) {
    const key = buildIdempotencyKey(subjectType, subjectId, item.offsetMinutes, item.fireAt);

    const [existing] = await db
      .select({ id: notificationJobs.id, status: notificationJobs.status })
      .from(notificationJobs)
      .where(eq(notificationJobs.idempotencyKey, key))
      .limit(1);

    if (!existing) {
      await db.insert(notificationJobs).values({
        ruleId,
        subjectType,
        subjectId,
        title: item.title,
        body: item.body,
        fireAt: item.fireAt,
        status: 'pending',
        idempotencyKey: key,
      });
      created += 1;
      continue;
    }

    // 已发送的绝不复位：重复送达比漏发更难收拾
    if (existing.status === 'sent') {
      skippedSent += 1;
      continue;
    }

    await db
      .update(notificationJobs)
      .set({
        status: 'pending',
        ruleId,
        title: item.title,
        body: item.body,
        fireAt: item.fireAt,
        attempts: 0,
        maxAttempts: 3,
        failureKind: null,
        lastError: null,
        nextAttemptAt: null,
        leasedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(notificationJobs.id, existing.id));
    resurrected += 1;
  }

  return { created, resurrected, cancelled: cancelledRows.length, skippedSent };
}

/** 依据事件当前状态重建提醒 */
export async function rebuildEventNotifications(eventId: string): Promise<RebuildResult> {
  const [event] = await db
    .select({
      id: events.id,
      title: events.title,
      location: events.location,
      startAt: events.startAt,
      status: events.status,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event) throw new Error(`事件不存在：${eventId}`);

  const empty: RebuildResult = {
    created: 0,
    resurrected: 0,
    cancelled: 0,
    skippedPast: 0,
    skippedSent: 0,
    ruleEnabled: false,
  };

  if (event.status !== 'active') {
    const cancelled = await cancelActiveNotifications('event', eventId);
    return { ...empty, cancelled };
  }

  const rule = await loadRule('event', eventId);
  if (!rule || !rule.enabled) {
    const cancelled = await cancelActiveNotifications('event', eventId);
    return { ...empty, cancelled };
  }

  const offsets = normalizeOffsets(Array.isArray(rule.offsets) ? (rule.offsets as number[]) : []);
  const now = Date.now();
  const plan: ReminderPlan[] = [];
  let skippedPast = 0;

  for (const offset of offsets) {
    const fireAt = new Date(event.startAt.getTime() - offset * 60_000);
    // 创建时已经过去的提醒时间不补发（PRD FR-07）
    if (fireAt.getTime() <= now) {
      skippedPast += 1;
      continue;
    }
    plan.push({
      offsetMinutes: offset,
      fireAt,
      title: event.title,
      body: [event.location ? `地点：${event.location}` : null, `${offsetLabel(offset)}提醒`]
        .filter(Boolean)
        .join(' · '),
    });
  }

  const applied = await applyPlan('event', eventId, rule.id, plan);
  return { ...applied, skippedPast, ruleEnabled: true };
}

/**
 * 待办提醒重建。
 *
 * PRD FR-02：有日期无具体时刻的待办是全天项目，**不能**精确到分钟提醒；
 * 要精确提醒必须补上具体时刻。因此没有 dueTime 时一律不排提醒。
 */
export async function rebuildTaskNotifications(taskId: string): Promise<RebuildResult> {
  const [task] = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      dueDate: tasks.dueDate,
      dueTime: tasks.dueTime,
      status: tasks.status,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);

  if (!task) throw new Error(`待办不存在：${taskId}`);

  const empty: RebuildResult = {
    created: 0,
    resurrected: 0,
    cancelled: 0,
    skippedPast: 0,
    skippedSent: 0,
    ruleEnabled: false,
  };

  if (task.status !== 'todo' || !task.dueDate || !task.dueTime) {
    const cancelled = await cancelActiveNotifications('task', taskId);
    return { ...empty, cancelled };
  }

  const rule = await loadRule('task', taskId);
  if (!rule || !rule.enabled) {
    const cancelled = await cancelActiveNotifications('task', taskId);
    return { ...empty, cancelled };
  }

  const [hh, mm] = task.dueTime.split(':').map(Number);
  const [y, mo, d] = task.dueDate.split('-').map(Number);
  const dueAt = zonedToInstant(y!, mo!, d!, hh ?? 0, mm ?? 0);

  const offsets = normalizeOffsets(Array.isArray(rule.offsets) ? (rule.offsets as number[]) : []);
  const now = Date.now();
  const plan: ReminderPlan[] = [];
  let skippedPast = 0;

  for (const offset of offsets) {
    const fireAt = new Date(dueAt.getTime() - offset * 60_000);
    if (fireAt.getTime() <= now) {
      skippedPast += 1;
      continue;
    }
    plan.push({
      offsetMinutes: offset,
      fireAt,
      title: task.title,
      body: `待办截止 ${task.dueDate} ${task.dueTime.slice(0, 5)} · ${offsetLabel(offset)}提醒`,
    });
  }

  const applied = await applyPlan('task', taskId, rule.id, plan);
  return { ...applied, skippedPast, ruleEnabled: true };
}

export type SubscriptionRebuildResult = RebuildResult & {
  /** 本次提醒针对的日期（下次扣费日或服务到期日） */
  targetDate: string | null;
  /** billing=扣费提醒，service_end=到期提醒 */
  kind: 'billing' | 'service_end' | null;
};

/**
 * 订阅提醒重建（PRD FR-05 / FR-07：每项订阅独立配置通知开关、提前天数/时刻）。
 *
 * 语义：
 *   - 自动续费**开启** → 提醒"下次扣费"（提前 N 天，在指定时刻发送）；
 *   - 自动续费**关闭** → 提醒"服务到期"，因为此时不会有下一次扣费；
 *   - 已结束 / 已暂停 / 未开启提醒 → 不排提醒，并取消未发送的旧提醒；
 *   - 已经过去的提醒时刻不补发。
 */
export async function rebuildSubscriptionNotifications(
  subscriptionId: string,
): Promise<SubscriptionRebuildResult> {
  const [row] = await db
    .select({
      id: subscriptions.id,
      name: subscriptions.name,
      status: subscriptions.status,
      autoRenew: subscriptions.autoRenew,
      nextBillingDate: subscriptions.nextBillingDate,
      serviceEndDate: subscriptions.serviceEndDate,
      reminderEnabled: subscriptions.reminderEnabled,
      reminderDaysBefore: subscriptions.reminderDaysBefore,
      reminderTime: subscriptions.reminderTime,
      price: subscriptions.price,
      currency: subscriptions.currency,
    })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId))
    .limit(1);

  if (!row) throw new Error(`订阅不存在：${subscriptionId}`);

  const empty: RebuildResult = {
    created: 0,
    resurrected: 0,
    cancelled: 0,
    skippedPast: 0,
    skippedSent: 0,
    ruleEnabled: false,
  };

  const stop = async (): Promise<SubscriptionRebuildResult> => {
    const cancelled = await cancelActiveNotifications('subscription', subscriptionId);
    return { ...empty, cancelled, targetDate: null, kind: null };
  };

  if (row.status === 'ended' || row.status === 'paused' || !row.reminderEnabled) return stop();

  // 自动续费关闭时不会有下一次扣费，提醒服务到期才有意义
  const kind: 'billing' | 'service_end' = row.autoRenew ? 'billing' : 'service_end';
  const targetDate =
    (row.autoRenew ? row.nextBillingDate : row.serviceEndDate) ?? row.nextBillingDate ?? row.serviceEndDate;
  if (!targetDate) return stop();

  const daysBefore = row.reminderDaysBefore ?? 3;
  const [hh, mm] = (row.reminderTime ?? '09:00').split(':').map(Number);
  const remindDate = addDays(targetDate, -daysBefore);
  const [y, mo, d] = remindDate.split('-').map(Number);
  const fireAt = zonedToInstant(y!, mo!, d!, hh ?? 9, mm ?? 0);

  const ruleId = await upsertRule('subscription', subscriptionId, {
    enabled: true,
    offsetsMinutes: [daysBefore * 1440],
  });

  const title = kind === 'billing' ? `${row.name} 即将扣费` : `${row.name} 即将到期`;
  const detail =
    kind === 'billing'
      ? `将于 ${targetDate} 扣费${row.price ? ` ${row.price} ${row.currency}` : ''}`
      : `服务将于 ${targetDate} 到期`;

  const now = Date.now();
  const plan: ReminderPlan[] = [];
  let skippedPast = 0;

  // 已经过去的提醒时刻不补发
  if (fireAt.getTime() <= now) {
    skippedPast = 1;
  } else {
    plan.push({
      offsetMinutes: daysBefore * 1440,
      fireAt,
      title,
      body: `${detail}（提前 ${daysBefore} 天提醒）`,
    });
  }

  const applied = await applyPlan('subscription', subscriptionId, ruleId, plan);
  return { ...applied, skippedPast, ruleEnabled: true, targetDate, kind };
}

/** 事项被物理删除：清掉未发送任务、规则与任务记录，避免悬挂引用 */
export async function purgeSubjectNotifications(
  subjectType: SubjectType,
  subjectId: string,
): Promise<void> {
  await cancelActiveNotifications(subjectType, subjectId);
  await db
    .delete(notificationRules)
    .where(
      and(eq(notificationRules.subjectType, subjectType), eq(notificationRules.subjectId, subjectId)),
    );
  await db
    .delete(notificationJobs)
    .where(
      and(eq(notificationJobs.subjectType, subjectType), eq(notificationJobs.subjectId, subjectId)),
    );
}

/** 供界面展示：某事项的全部提醒 */
export async function listSubjectJobs(subjectType: SubjectType, subjectId: string) {
  return db
    .select({
      id: notificationJobs.id,
      fireAt: notificationJobs.fireAt,
      status: notificationJobs.status,
      failureKind: notificationJobs.failureKind,
      attempts: notificationJobs.attempts,
      lastError: notificationJobs.lastError,
    })
    .from(notificationJobs)
    .where(and(eq(notificationJobs.subjectType, subjectType), eq(notificationJobs.subjectId, subjectId)))
    .orderBy(notificationJobs.fireAt);
}

/** 统计各状态任务数，供仪表盘使用 */
export async function countJobsByStatus(): Promise<Record<string, number>> {
  const rows = await db.execute(
    sql`SELECT status, count(*)::int AS n FROM notification_jobs GROUP BY status`,
  );
  const result = (rows as unknown as { rows: { status: string; n: number }[] }).rows ?? [];
  const out: Record<string, number> = {};
  for (const r of result) out[r.status] = r.n;
  return out;
}

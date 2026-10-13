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
import type { SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { events, notificationJobs, notificationRules, subscriptions, tasks } from '../db/schema';
import { ownedBy } from './scope';
import { addDays, zonedToInstant } from './time';

export type SubjectType = 'event' | 'task' | 'subscription';

/**
 * 事务客户端的结构化类型（只声明本模块用到的方法）。
 *
 * 为什么需要它：PRD 7.2 要求"事项创建 + 提醒规则与任务调整 + 操作标记 + 回复入队"
 * 在**同一事务**中完成。原实现只接受全局 `db`，导致共享创建服务无法做到原子——
 * 这里把客户端作为可选参数贯穿，Web 路由保持传 `db`（行为不变），
 * 微信创建服务传事务对象。
 */
export type Scheduler = {
  select: typeof db.select;
  insert: typeof db.insert;
  update: typeof db.update;
  delete: typeof db.delete;
  execute: typeof db.execute;
};

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

/**
 * 事项的归属账号；事项不存在时返回 null（调用方按 fail closed 处理）。
 *
 * 归属一律由 subject **推导**，不从调用方传入 —— 调用签名因此不用改，
 * 归属也不可能被写错。三种主体分开写：用主体类型拼动态表名会丢掉类型安全，
 * 而这里要的正是"列名写错就编译不过"。
 */
async function subjectOwner(
  subjectType: SubjectType,
  subjectId: string,
  scheduler: Scheduler = db,
): Promise<number | null> {
  switch (subjectType) {
    case 'event': {
      const [row] = await scheduler
        .select({ userId: events.userId })
        .from(events)
        .where(eq(events.id, subjectId))
        .limit(1);
      return row?.userId ?? null;
    }
    case 'task': {
      const [row] = await scheduler
        .select({ userId: tasks.userId })
        .from(tasks)
        .where(eq(tasks.id, subjectId))
        .limit(1);
      return row?.userId ?? null;
    }
    case 'subscription': {
      const [row] = await scheduler
        .select({ userId: subscriptions.userId })
        .from(subscriptions)
        .where(eq(subscriptions.id, subjectId))
        .limit(1);
      return row?.userId ?? null;
    }
  }
}

export async function cancelActiveNotifications(
  subjectType: SubjectType,
  subjectId: string,
  scheduler: Scheduler = db,
): Promise<number> {
  // 归属由 subject 推导；推导不出（事项已不存在）时不动任何行，fail closed
  const userId = await subjectOwner(subjectType, subjectId, scheduler);
  if (userId === null) return 0;

  const rows = await scheduler
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
        ownedBy(notificationJobs, userId),
        inArray(notificationJobs.status, [...ACTIVE_JOB_STATUSES]),
      ),
    )
    .returning({ id: notificationJobs.id });

  return rows.length;
}

export type ReminderRuleInput = { enabled: boolean; offsetsMinutes: number[] };

/** 事件与待办共用同一套规则表，只是主体类型不同 */
export async function upsertRule(
  subjectType: SubjectType,
  subjectId: string,
  input: ReminderRuleInput,
  scheduler: Scheduler = db,
): Promise<string> {
  const offsets = normalizeOffsets(input.offsetsMinutes);

  // 规则必须落在**事项所有者**名下，而不是调用者名下：归属从 subject 推导
  const userId = await subjectOwner(subjectType, subjectId, scheduler);
  if (userId === null) {
    throw new Error(`事项不存在，无法建立提醒规则：${subjectType}:${subjectId}`);
  }

  const [row] = await scheduler
    .insert(notificationRules)
    .values({
      userId,
      subjectType,
      subjectId,
      channel: 'wechat',
      enabled: input.enabled,
      offsetsMinutes: offsets,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      // 冲突目标只可能是"同一主体 + 同一渠道"的那一行（subject_id 全局唯一 uuid），
      // 它的归属只可能等于上面推导出的 userId，因此 set 不会跨账号改写
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

/**
 * 读事项的提醒规则。
 *
 * `userId` 由调用方（rebuild 函数）一并读出后传入：这些函数本来就要读事项行，
 * 顺手取 `userId` 不额外查库，也不给 `loadRule` 留"可以不带归属"的口子。
 */
async function loadRule(
  subjectType: 'event' | 'task',
  subjectId: string,
  userId: number,
  scheduler: Scheduler = db,
) {
  const [rule] = await scheduler
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
        ownedBy(notificationRules, userId),
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
 *
 * `userId` 是必填参数：本函数每次都只由已经知道归属的 rebuild 函数调用，
 * 归属以参数显式传下来，避免在这里再查一次事项表。
 */
async function applyPlan(
  subjectType: SubjectType,
  subjectId: string,
  ruleId: string,
  userId: number,
  plan: ReminderPlan[],
  scheduler: Scheduler = db,
): Promise<{ created: number; resurrected: number; cancelled: number; skippedSent: number }> {
  const keys = plan.map((p) => buildIdempotencyKey(subjectType, subjectId, p.offsetMinutes, p.fireAt));

  // 1) 取消不再需要的活动提醒（幂等键不在计划内的）
  const cancelWhere = [
    eq(notificationJobs.subjectType, subjectType),
    eq(notificationJobs.subjectId, subjectId),
    ownedBy(notificationJobs, userId),
    inArray(notificationJobs.status, [...ACTIVE_JOB_STATUSES]),
  ];
  if (keys.length > 0) cancelWhere.push(notInArray(notificationJobs.idempotencyKey, keys));

  const cancelledRows = await scheduler
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

    const [existing] = await scheduler
      .select({ id: notificationJobs.id, status: notificationJobs.status })
      .from(notificationJobs)
      .where(and(eq(notificationJobs.idempotencyKey, key), ownedBy(notificationJobs, userId)))
      .limit(1);

    if (!existing) {
      await scheduler.insert(notificationJobs).values({
        ruleId,
        userId,
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

    await scheduler
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
      .where(and(eq(notificationJobs.id, existing.id), ownedBy(notificationJobs, userId)));
    resurrected += 1;
  }

  return { created, resurrected, cancelled: cancelledRows.length, skippedSent };
}

/** 依据事件当前状态重建提醒 */
export async function rebuildEventNotifications(eventId: string, scheduler: Scheduler = db): Promise<RebuildResult> {
  const [event] = await scheduler
    .select({
      id: events.id,
      // 归属顺手一并读出：后续取消规则/任务都只在该账号内进行
      userId: events.userId,
      title: events.title,
      location: events.location,
      startAt: events.startAt,
      status: events.status,
    })
    .from(events)
    // 这里**刻意只按主键读**：本函数只拿到 subjectId，这一行读出 `userId` 才是
    // 归属的**推导点**，紧接着的规则与提醒任务全部在该 userId 内读写。
    // 不要在这里加 `user_id = user_id` 之类的恒真条件——它看起来像归属校验，
    // 实际什么都没做，还会让 `grep ownedBy(` 的覆盖审计误判为已覆盖。
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
    const cancelled = await cancelActiveNotifications('event', eventId, scheduler);
    return { ...empty, cancelled };
  }

  const rule = await loadRule('event', eventId, event.userId, scheduler);
  if (!rule || !rule.enabled) {
    const cancelled = await cancelActiveNotifications('event', eventId, scheduler);
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

  const applied = await applyPlan('event', eventId, rule.id, event.userId, plan, scheduler);
  return { ...applied, skippedPast, ruleEnabled: true };
}

/**
 * 待办提醒重建。
 *
 * PRD FR-02：有日期无具体时刻的待办是全天项目，**不能**精确到分钟提醒；
 * 要精确提醒必须补上具体时刻。因此没有 dueTime 时一律不排提醒。
 */
export async function rebuildTaskNotifications(taskId: string, scheduler: Scheduler = db): Promise<RebuildResult> {
  const [task] = await scheduler
    .select({
      id: tasks.id,
      // 归属顺手一并读出：后续取消规则/任务都只在该账号内进行
      userId: tasks.userId,
      title: tasks.title,
      dueDate: tasks.dueDate,
      dueTime: tasks.dueTime,
      status: tasks.status,
    })
    .from(tasks)
    // 归属推导点，理由同 rebuildEventNotifications：只按主键读，不加恒真条件
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
    const cancelled = await cancelActiveNotifications('task', taskId, scheduler);
    return { ...empty, cancelled };
  }

  const rule = await loadRule('task', taskId, task.userId, scheduler);
  if (!rule || !rule.enabled) {
    const cancelled = await cancelActiveNotifications('task', taskId, scheduler);
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

  const applied = await applyPlan('task', taskId, rule.id, task.userId, plan, scheduler);
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
      // 归属顺手一并读出：后续取消规则/任务都只在该账号内进行
      userId: subscriptions.userId,
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
    // 归属推导点，理由同 rebuildEventNotifications：只按主键读，不加恒真条件
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

  const applied = await applyPlan('subscription', subscriptionId, ruleId, row.userId, plan);
  return { ...applied, skippedPast, ruleEnabled: true, targetDate, kind };
}

/**
 * 事项被物理删除：清掉未发送任务、规则与任务记录，避免悬挂引用。
 *
 * 归属边界（重要）：本函数在**删除事项**时调用，事项行此刻可能已经不存在，
 * 于是 `subjectOwner` 可能返回 null。处理方式是：能推导出 owner 就带上归属过滤；
 * 推导不出时退化为只按 `(subjectType, subjectId)` 删除，这是安全的，理由是：
 * `subjectId` 是全局唯一的 uuid，一条提醒任务/规则只会引用它**自己主人**的
 * subjectId —— 别人的提醒引用的是别人自己的 subjectId。因此按 subjectId 删除
 * 在物理上不可能命中他人的行；而调用方（routes 的删除路径）已经先按
 * `ownedBy(表, userId)` 校验过事项归属，不会替别人发起清理。
 */
export async function purgeSubjectNotifications(
  subjectType: SubjectType,
  subjectId: string,
): Promise<void> {
  const userId = await subjectOwner(subjectType, subjectId);

  await cancelActiveNotifications(subjectType, subjectId);

  // 能推导出 owner 时补上归属过滤；推导不出（事项行已删）时见上方注释的边界说明
  const ruleWhere: SQL[] = [
    eq(notificationRules.subjectType, subjectType),
    eq(notificationRules.subjectId, subjectId),
  ];
  if (userId !== null) ruleWhere.push(ownedBy(notificationRules, userId));
  await db.delete(notificationRules).where(and(...ruleWhere));

  const jobWhere: SQL[] = [
    eq(notificationJobs.subjectType, subjectType),
    eq(notificationJobs.subjectId, subjectId),
  ];
  if (userId !== null) jobWhere.push(ownedBy(notificationJobs, userId));
  await db.delete(notificationJobs).where(and(...jobWhere));
}

/** 编辑回显：某事项当前生效的微信提醒规则（无规则时为 null） */
export async function getSubjectRule(subjectType: SubjectType, subjectId: string) {
  // 归属由 subject 推导；推导不出（事项不存在或不属于任何人）时按"没有规则"返回
  const userId = await subjectOwner(subjectType, subjectId);
  if (userId === null) return null;

  const [row] = await db
    .select({
      enabled: notificationRules.enabled,
      offsetsMinutes: notificationRules.offsetsMinutes,
    })
    .from(notificationRules)
    .where(
      and(
        eq(notificationRules.subjectType, subjectType),
        eq(notificationRules.subjectId, subjectId),
        eq(notificationRules.channel, 'wechat'),
        ownedBy(notificationRules, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 供界面展示：某事项的全部提醒 */
export async function listSubjectJobs(subjectType: SubjectType, subjectId: string) {
  // 归属由 subject 推导；推导不出时返回空列表，不抛错（列表接口按空展示更合适）
  const userId = await subjectOwner(subjectType, subjectId);
  if (userId === null) return [];

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
    .where(
      and(
        eq(notificationJobs.subjectType, subjectType),
        eq(notificationJobs.subjectId, subjectId),
        ownedBy(notificationJobs, userId),
      ),
    )
    .orderBy(notificationJobs.fireAt);
}

/**
 * 统计各状态任务数，供仪表盘使用。
 *
 * `userId` 可选：传入时只统计该账号（仪表盘用），不传时保持原有的全局语义
 * （Worker / 运维视角）。`userId` 用占位符绑定，不拼字符串。
 */
export async function countJobsByStatus(userId?: number): Promise<Record<string, number>> {
  const rows = await db.execute(
    userId === undefined
      ? sql`SELECT status, count(*)::int AS n FROM notification_jobs GROUP BY status`
      : sql`SELECT status, count(*)::int AS n FROM notification_jobs WHERE user_id = ${userId} GROUP BY status`,
  );
  const result = (rows as unknown as { rows: { status: string; n: number }[] }).rows ?? [];
  const out: Record<string, number> = {};
  for (const r of result) out[r.status] = r.n;
  return out;
}

/**
 * 微信操作仓储与原子创建（PRD 6、7.2、8.1）。
 *
 * 两件事必须成立，否则整个 V1.1 不可信：
 *
 * 1. **同一绑定会话至多一个活动创建操作。**
 *    由数据库偏唯一索引 `wechat_operations_active_uq` 保证，应用只做友好提示。
 *    应用层判断在并发与重启面前不可靠，所以真正的约束必须落到数据库。
 *
 * 2. **提交是原子的。** 事项/待办创建、提醒规则与提醒任务、操作终态标记、
 *    回复入队，全部在**同一事务**内完成（PRD 7.2）。任何一步失败都整体回滚，
 *    不会出现"事项建好了但没有提醒"或"回复说已创建但库里没有"。
 *    模型调用与外部发送一律不在事务内。
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { events, notificationJobs, notificationRules, tasks, wechatOperations } from '../db/schema';
import { buildIdempotencyKey } from './scheduling';
import { enqueueReply, type TxLike } from './wechat-outbox';
import {
  DEFAULT_OFFSETS,
  type Draft,
  type DraftKind,
  type OperationStatus,
  draftTimeText,
  effectiveOffsets,
  planReminders,
  renewedExpiry,
} from './wechat-draft';

/** 活动（可变更）状态：与数据库偏唯一索引的谓词必须保持一致 */
export const ACTIVE_STATUSES = ['awaiting_fields', 'pending_confirm', 'committing'] as const;

export type OperationRow = {
  id: string;
  bindingGeneration: string;
  kind: string;
  draftKind: DraftKind | null;
  status: OperationStatus;
  version: number;
  shortCode: string | null;
  draft: Draft | null;
  missingFields: string[] | null;
  idempotencyKey: string;
  previewRevision: string | null;
  expiresAt: Date;
  committedAt: Date | null;
  cancelledAt: Date | null;
  expiredAt: Date | null;
  resultSubjectType: string | null;
  resultSubjectId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const SELECT_COLUMNS = {
  id: wechatOperations.id,
  bindingGeneration: wechatOperations.bindingGeneration,
  kind: wechatOperations.kind,
  draftKind: wechatOperations.draftKind,
  status: wechatOperations.status,
  version: wechatOperations.version,
  shortCode: wechatOperations.shortCode,
  draft: wechatOperations.draft,
  missingFields: wechatOperations.missingFields,
  idempotencyKey: wechatOperations.idempotencyKey,
  previewRevision: wechatOperations.previewRevision,
  expiresAt: wechatOperations.expiresAt,
  committedAt: wechatOperations.committedAt,
  cancelledAt: wechatOperations.cancelledAt,
  expiredAt: wechatOperations.expiredAt,
  resultSubjectType: wechatOperations.resultSubjectType,
  resultSubjectId: wechatOperations.resultSubjectId,
  createdAt: wechatOperations.createdAt,
  updatedAt: wechatOperations.updatedAt,
};

type RawOperation = Omit<OperationRow, 'draft' | 'missingFields' | 'draftKind' | 'status'> & {
  draft: unknown;
  missingFields: unknown;
  draftKind: string | null;
  status: string;
};

function normalize(row: RawOperation): OperationRow {
  return {
    ...row,
    status: row.status as OperationStatus,
    draftKind: (row.draftKind as DraftKind | null) ?? null,
    draft: (row.draft as Draft | null) ?? null,
    missingFields: Array.isArray(row.missingFields) ? (row.missingFields as string[]) : null,
  };
}

/** 当前活动创建操作（至多一条） */
export async function loadActiveOperation(generation: string): Promise<OperationRow | null> {
  const [row] = await db
    .select(SELECT_COLUMNS)
    .from(wechatOperations)
    .where(
      and(
        eq(wechatOperations.bindingGeneration, generation),
        inArray(wechatOperations.status, [...ACTIVE_STATUSES]),
      ),
    )
    .limit(1);
  return row ? normalize(row as RawOperation) : null;
}

/** 最近的操作记录，供 /recent 核实"是否保存成功" */
export async function listRecentOperations(generation: string, limit = 5): Promise<OperationRow[]> {
  const rows = await db
    .select(SELECT_COLUMNS)
    .from(wechatOperations)
    .where(eq(wechatOperations.bindingGeneration, generation))
    .orderBy(desc(wechatOperations.updatedAt))
    .limit(limit);
  return rows.map((r) => normalize(r as RawOperation));
}

/** 按短码定位操作（仅限该代际、且仍是活动状态） */
export async function findByShortCode(
  generation: string,
  shortCode: string,
): Promise<OperationRow | null> {
  const [row] = await db
    .select(SELECT_COLUMNS)
    .from(wechatOperations)
    .where(
      and(
        eq(wechatOperations.bindingGeneration, generation),
        eq(wechatOperations.shortCode, shortCode),
        inArray(wechatOperations.status, [...ACTIVE_STATUSES]),
      ),
    )
    .limit(1);
  return row ? normalize(row as RawOperation) : null;
}

export type CreateOperationInput = {
  bindingGeneration: string;
  kind?: 'create' | 'query';
  draftKind: DraftKind;
  draft: Draft;
  missingFields: string[];
  shortCode: string;
  sourceInboxId: string;
  now?: Date;
};

/**
 * 新建草稿操作。
 *
 * 幂等键绑定"来源消息 + 代际"：同一条入站消息被重复处理时不会造出第二个草稿。
 * 偏唯一索引会拦下"已有活动草稿却又新建"，此时返回 null 由上层提示先处理当前草稿。
 */
export async function createOperation(input: CreateOperationInput): Promise<OperationRow | null> {
  const now = input.now ?? new Date();
  const rows = await db
    .insert(wechatOperations)
    .values({
      bindingGeneration: input.bindingGeneration,
      kind: input.kind ?? 'create',
      draftKind: input.draftKind,
      status: input.missingFields.length > 0 ? 'awaiting_fields' : 'pending_confirm',
      version: 1,
      shortCode: input.shortCode,
      draft: input.draft,
      missingFields: input.missingFields,
      sourceInboxId: input.sourceInboxId,
      idempotencyKey: `wechat:${input.bindingGeneration}:${input.sourceInboxId}`,
      expiresAt: renewedExpiry(now),
      updatedAt: now,
    })
    // 幂等键冲突（同一条消息重复处理）或活动草稿冲突都返回空
    .onConflictDoNothing()
    .returning(SELECT_COLUMNS);

  return rows[0] ? normalize(rows[0] as RawOperation) : null;
}

export type UpdateOperationInput = {
  operationId: string;
  draft?: Draft;
  missingFields?: string[];
  shortCode?: string;
  /** 递增版本 */
  bumpVersion?: boolean;
  status?: OperationStatus;
  previewRevision?: string | null;
  now?: Date;
};

/**
 * 更新草稿：每次有效修改递增版本并续期（PRD 3.3、16.1-4）。
 *
 * **状态必须由"是否还缺字段"推导**，不能让调用方忘记设置：
 * `commitOperation` 只接受 `pending_confirm`，如果补全字段后状态仍停在
 * `awaiting_fields`，草稿会永久卡死、无法确认（这是实际发生过的缺陷）。
 * 因此当本次更新提供了 `missingFields` 时，状态一并推导；
 * 调用方显式传入 `status` 时以调用方为准。
 */
export async function updateOperation(input: UpdateOperationInput): Promise<OperationRow | null> {
  const now = input.now ?? new Date();
  const derivedStatus =
    input.status ??
    (input.missingFields !== undefined
      ? input.missingFields.length > 0
        ? 'awaiting_fields'
        : 'pending_confirm'
      : undefined);

  const rows = await db
    .update(wechatOperations)
    .set({
      ...(input.draft !== undefined ? { draft: input.draft } : {}),
      ...(input.missingFields !== undefined
        ? { missingFields: input.missingFields }
        : {}),
      ...(input.shortCode !== undefined ? { shortCode: input.shortCode } : {}),
      ...(derivedStatus !== undefined ? { status: derivedStatus } : {}),
      ...(input.previewRevision !== undefined ? { previewRevision: input.previewRevision } : {}),
      ...(input.bumpVersion ? { version: sql`${wechatOperations.version} + 1` } : {}),
      // 每次有效修改都续期
      expiresAt: renewedExpiry(now),
      updatedAt: now,
    })
    .where(and(eq(wechatOperations.id, input.operationId), inArray(wechatOperations.status, [...ACTIVE_STATUSES])))
    .returning(SELECT_COLUMNS);
  return rows[0] ? normalize(rows[0] as RawOperation) : null;
}

/** 主动取消：只放弃未保存草稿（PRD 3.4） */
export async function cancelOperation(operationId: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(wechatOperations)
    .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
    .where(and(eq(wechatOperations.id, operationId), inArray(wechatOperations.status, [...ACTIVE_STATUSES])))
    .returning({ id: wechatOperations.id });
  return rows.length > 0;
}

/**
 * 过期（PRD 16.1-4）：由处理器在发现超期时标记，旧短码随之失效。
 *
 * 返回被过期的操作（含代际与短码），因为 **PRD 3.4 要求过期时明确提示用户**
 * "上一草稿已过期，未保存"。只改状态不通知的话，用户会在回复确认短码时
 * 只得到"短码不正确"，既不知道草稿已过期、也不知道它去了哪里。
 */
export async function expireStaleOperations(
  now = new Date(),
): Promise<{ id: string; bindingGeneration: string; shortCode: string | null; title: string | null }[]> {
  const rows = await db
    .update(wechatOperations)
    .set({ status: 'expired', expiredAt: now, updatedAt: now })
    .where(and(inArray(wechatOperations.status, [...ACTIVE_STATUSES]), sql`${wechatOperations.expiresAt} <= ${now.toISOString()}`))
    .returning({
      id: wechatOperations.id,
      bindingGeneration: wechatOperations.bindingGeneration,
      shortCode: wechatOperations.shortCode,
      draft: wechatOperations.draft,
    });
  return rows.map((r) => {
    const draft = (r.draft as { title?: string } | null) ?? null;
    return {
      id: r.id,
      bindingGeneration: r.bindingGeneration,
      shortCode: r.shortCode,
      title: typeof draft?.title === 'string' && draft.title.trim() ? draft.title : null,
    };
  });
}

/** 换绑/解绑：活动草稿作废（PRD 6、7.3） */
export async function invalidateOperations(generation: string, now = new Date()): Promise<number> {
  const rows = await db
    .update(wechatOperations)
    .set({ status: 'invalidated', updatedAt: now })
    .where(and(eq(wechatOperations.bindingGeneration, generation), inArray(wechatOperations.status, [...ACTIVE_STATUSES])))
    .returning({ id: wechatOperations.id });
  return rows.length;
}

export type CommitResult =
  | { ok: true; subjectType: 'event' | 'task'; subjectId: string; createdJobs: number; skippedPast: number }
  | { ok: false; reason: string };

/**
 * 原子提交（PRD 7.2）。
 *
 * 事务内顺序：重新校验版本 → 创建事项 → 写提醒规则 → 建提醒任务 →
 * 标记操作 committed → 回复入队。
 *
 * 三重防护避免重复创建：
 *   1. `SELECT ... FOR UPDATE` 锁住该行，并发确认只有一个能通过；
 *   2. 状态必须是 `pending_confirm`，`committing`/`committed` 一律拒绝；
 *   3. 操作上的幂等键使重复调用复用同一结果。
 */
export async function commitOperation(
  operationId: string,
  expectedVersion: number,
  now = new Date(),
): Promise<CommitResult> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute<{
      id: string;
      status: string;
      version: number;
      draft: Draft | null;
      short_code: string | null;
      binding_generation: string;
      result_subject_type: string | null;
      result_subject_id: string | null;
      idempotency_key: string;
    }>(sql`
      SELECT id, status, version, draft, short_code, binding_generation,
             result_subject_type, result_subject_id, idempotency_key
      FROM wechat_operations WHERE id = ${operationId} FOR UPDATE
    `);

    const row = locked.rows?.[0];
    if (!row) return { ok: false, reason: '操作不存在' };

    // 已提交：返回原结果，不重复创建（PRD 3.3 重复确认只能反馈原结果）
    if (row.status === 'committed' && row.result_subject_id && row.result_subject_type) {
      return {
        ok: true,
        subjectType: row.result_subject_type as 'event' | 'task',
        subjectId: row.result_subject_id,
        createdJobs: 0,
        skippedPast: 0,
      };
    }
    if (row.status !== 'pending_confirm') {
      return { ok: false, reason: `草稿状态为 ${row.status}，不能提交` };
    }
    if (row.version !== expectedVersion) {
      return { ok: false, reason: '草稿已更新，请按最新短码确认' };
    }

    const draft = row.draft;
    if (!draft) return { ok: false, reason: '草稿内容缺失' };

    // 1) 创建事项
    let subjectType: 'event' | 'task';
    let subjectId: string;

    if (draft.kind === 'event') {
      const [created] = await tx
        .insert(events)
        .values({
          title: draft.title,
          startAt: new Date(draft.startAt!),
          endAt: draft.endAt ? new Date(draft.endAt) : null,
          location: draft.location,
          note: draft.note,
          source: 'wechat',
        })
        .returning({ id: events.id });
      subjectType = 'event';
      subjectId = created!.id;
    } else {
      const [created] = await tx
        .insert(tasks)
        .values({
          title: draft.title,
          dueDate: draft.dueDate,
          dueTime: draft.dueTime,
          note: draft.note,
          source: 'wechat',
        })
        .returning({ id: tasks.id });
      subjectType = 'task';
      subjectId = created!.id;
    }

    // 2) 提醒规则 + 提醒任务（在同一事务内，避免"事项建好但提醒丢了"）
    const offsets = effectiveOffsets(draft);
    const ruleEnabled = offsets.length > 0;

    const [ruleRow] = await tx
      .insert(notificationRules)
      .values({
        subjectType,
        subjectId,
        channel: 'wechat',
        enabled: ruleEnabled,
        offsetsMinutes: offsets,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [notificationRules.subjectType, notificationRules.subjectId, notificationRules.channel],
        set: { enabled: ruleEnabled, offsetsMinutes: offsets, updatedAt: now },
      })
      .returning({ id: notificationRules.id });
    const ruleId = ruleRow!.id;

    const { plan, skippedPast } = planReminders(draft, now);
    let createdJobs = 0;
    for (const item of plan) {
      const key = buildIdempotencyKey(subjectType, subjectId, item.offsetMinutes, item.fireAt);
      const body =
        subjectType === 'event'
          ? [draft.location ? `地点：${draft.location}` : null, `${offsetText(item.offsetMinutes)}提醒`]
              .filter(Boolean)
              .join(' · ')
          : `待办截止 ${draft.dueDate} ${draft.dueTime ?? ''}`.trim() + ` · ${offsetText(item.offsetMinutes)}提醒`;

      await tx
        .insert(notificationJobs)
        .values({
          ruleId,
          subjectType,
          subjectId,
          title: draft.title,
          body,
          fireAt: item.fireAt,
          status: 'pending',
          idempotencyKey: key,
        })
        // 幂等键冲突说明该提醒已存在，跳过即可
        .onConflictDoNothing({ target: notificationJobs.idempotencyKey });
      createdJobs += 1;
    }

    // 3) 标记操作终态
    await tx
      .update(wechatOperations)
      .set({
        status: 'committed',
        committedAt: now,
        updatedAt: now,
        resultSubjectType: subjectType,
        resultSubjectId: subjectId,
      })
      .where(eq(wechatOperations.id, operationId));

    // 4) 回复入队（与上面同事务：要么都成立，要么都不成立）
    await enqueueReply(tx as unknown as TxLike, {
      bindingGeneration: row.binding_generation,
      operationId,
      operationVersion: row.version,
      replyType: 'created',
      body: createdReply(draft, subjectType, now),
      // 幂等键派生：同一次提交的重试不会产生第二条"已创建"
      dedupeKey: `created:${row.idempotency_key}`,
      now,
    });

    return { ok: true, subjectType, subjectId, createdJobs, skippedPast };
  });
}

function offsetText(minutes: number): string {
  if (minutes % 1440 === 0) return `提前 ${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `提前 ${minutes / 60} 小时`;
  return `提前 ${minutes} 分钟`;
}

/** 创建成功的结束标志（PRD 3.4）：明确告知本次结束、可以直接说下一项 */
export function createdReply(draft: Draft, subjectType: 'event' | 'task', now: Date): string {
  const lines: string[] = [];
  lines.push('✅ 已创建');
  lines.push(`事项：${draft.title}`);
  lines.push(`类型：${subjectType === 'event' ? '日程事件' : '待办'}`);
  // 必须显示用户所在时区的绝对时间，不能输出 UTC（PRD 3.2）
  const timeText = draftTimeText(draft);
  if (timeText) lines.push(`时间：${timeText}`);
  if (draft.location) lines.push(`地点：${draft.location}`);

  const { plan, skippedPast, total } = planReminders(draft, now);
  if (plan.length > 0) {
    lines.push(`提醒：${plan.map((p) => offsetText(p.offsetMinutes)).join('、')}`);
    if (skippedPast > 0) {
      lines.push(`（其中 ${skippedPast} 档因时间已过未安排）`);
    }
  } else if (total > 0) {
    lines.push('提醒：本次不安排提醒（时间已过）');
  } else {
    lines.push('提醒：未安排（未设置日期或时刻，可到工作站补充）');
  }

  lines.push('');
  lines.push('本次创建已结束。可以直接发送下一项安排。');
  return lines.join('\n');
}

export { DEFAULT_OFFSETS };

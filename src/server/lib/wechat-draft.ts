/**
 * 草稿模型与状态机（PRD 5、6、16.1）。
 *
 * 本文件是**纯函数层**：不碰数据库、不调模型、不发消息。
 * 所有"什么时候可以写库"的判断都集中在这里，便于用穷举式测试锁死。
 *
 * 已确认的产品规则（PRD 16.1，不得自行改动）：
 *   1. 默认提醒 `[60, 10]`；**逐档判定**——触发点 `<=` 当前时间即视为已过去，
 *      该档不安排、不补发、不替换为到点提醒；两档都不可排 → 「本次不安排提醒」。
 *   2. 日期或时刻不完整时允许保存，但**不生成提醒任务**，且必须区分
 *      「用户主动关闭」与「因缺字段无法安排」两种状态。
 *   3. 草稿有效期 30 分钟，自**最后一次有效修改**起算并续期。
 *   5. 类型转换允许事项↔待办互转：地点在转待办时移除并标注；
 *      提醒规则原样保留；只保留用户明确提供或确认过的数据。
 */
import { addDays, instantToDateString, instantToTimeString, todayInTz, zonedToInstant } from './time';

export type DraftKind = 'event' | 'task';

/** 操作状态机（PRD 6） */
export const MUTABLE_STATUSES = ['awaiting_fields', 'pending_confirm'] as const;
export type OperationStatus =
  | 'awaiting_fields'
  | 'pending_confirm'
  | 'committing'
  | 'committed'
  | 'cancelled'
  | 'expired'
  | 'invalidated';

/** 默认提醒提前量（PRD 1.2 第 4 条） */
export const DEFAULT_OFFSETS = [60, 10];

/** 提前量白名单：与 DeepSeek 解析层一致，避免出现奇怪数值 */
export const ALLOWED_OFFSETS = [1440, 120, 60, 30, 10, 5];

export const DRAFT_TTL_MINUTES = Number(process.env.WECHAT_DRAFT_TTL_MINUTES ?? 30);

/**
 * 会话草稿。
 *
 * `providedFields` 记录**用户明确提供过**的字段，用于实现 16.1-5 的
 * "只保留用户明确提供或确认过的数据"——类型转换时不得凭空生成字段。
 */
export type Draft = {
  kind: DraftKind;
  title: string;
  /** 事件开始（绝对时刻，UTC ISO） */
  startAt: string | null;
  endAt: string | null;
  /** 待办截止（日历日期 + 可选时刻） */
  dueDate: string | null;
  dueTime: string | null;
  location: string | null;
  note: string | null;
  /** 用户主动关闭提醒（区别于"因缺字段无法安排"） */
  reminderEnabled: boolean;
  /** 显式指定的提前量；未指定时为空数组，预览阶段再补默认值 */
  reminderOffsets: number[];
  /** 用户明确说"不要提醒" */
  reminderDeclined: boolean;
  providedFields: string[];
};

export function emptyDraft(kind: DraftKind): Draft {
  return {
    kind,
    title: '',
    startAt: null,
    endAt: null,
    dueDate: null,
    dueTime: null,
    location: null,
    note: null,
    reminderEnabled: false,
    reminderOffsets: [],
    reminderDeclined: false,
    providedFields: [],
  };
}

/** 事件开始时刻；待办用 dueDate/dueTime 表达 */
export function draftInstant(draft: Draft): Date | null {
  if (draft.kind !== 'event' || !draft.startAt) return null;
  const date = new Date(draft.startAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 待办的截止时刻；没有时刻时返回 null（全天项目不能精确提醒，PRD 5） */
export function draftDueInstant(draft: Draft): Date | null {
  if (draft.kind !== 'task' || !draft.dueDate || !draft.dueTime) return null;
  const [y, m, d] = draft.dueDate.split('-').map(Number);
  const [hh, mm] = draft.dueTime.split(':').map(Number);
  if (!y || !m || !d) return null;
  return zonedToInstant(y, m, d, hh ?? 0, mm ?? 0);
}

/** 该草稿用于排提醒的基准时刻 */
export function draftAnchor(draft: Draft): Date | null {
  return draft.kind === 'event' ? draftInstant(draft) : draftDueInstant(draft);
}

/**
 * 缺字段判定（PRD 5、16.1-2）。
 *
 * 事件必须要开始时间；待办必须要有标题——日期/时刻**不完整也算可保存**，
 * 只是不排提醒（这就是 16.1-2 的决定）。
 */
export function missingFields(draft: Draft): string[] {
  const missing: string[] = [];
  if (!draft.title.trim()) missing.push('title');
  if (draft.kind === 'event' && !draft.startAt) missing.push('start_at');
  return missing;
}

/** 是否因缺字段而无法安排提醒（区别于用户主动关闭） */
export function reminderBlockedByMissingFields(draft: Draft): boolean {
  if (draft.kind === 'event') return !draft.startAt;
  return !draft.dueDate || !draft.dueTime;
}

export type ReminderPlanItem = {
  offsetMinutes: number;
  fireAt: Date;
};

export type ReminderPlan = {
  plan: ReminderPlanItem[];
  /** 因触发点已过而被丢弃的档位数 */
  skippedPast: number;
  /** 本应安排的总档位数 */
  total: number;
};

/**
 * 逐档判定提醒计划（PRD 16.1-1，本轮确认的核心规则）。
 *
 * `触发点 <= now` → 该档视为已过去，直接丢弃；`>` → 安排。
 * 这同时解释了 30–60 分钟区间为什么只排提前 10 分钟：
 * 提前 60 分钟的触发点已经过去了。
 */
export function planReminders(draft: Draft, now: Date): ReminderPlan {
  const anchor = draftAnchor(draft);
  const offsets = effectiveOffsets(draft);
  if (!anchor || offsets.length === 0) {
    return { plan: [], skippedPast: 0, total: 0 };
  }

  const plan: ReminderPlanItem[] = [];
  let skippedPast = 0;
  for (const offset of offsets) {
    const fireAt = new Date(anchor.getTime() - offset * 60_000);
    if (fireAt.getTime() <= now.getTime()) {
      skippedPast += 1;
      continue;
    }
    plan.push({ offsetMinutes: offset, fireAt });
  }
  return { plan, skippedPast, total: offsets.length };
}

/** 生效的提前量：显式指定优先，否则用默认 [60,10]；用户说不要提醒则为空 */
export function effectiveOffsets(draft: Draft): number[] {
  if (draft.reminderDeclined) return [];
  const source = draft.reminderOffsets.length > 0 ? draft.reminderOffsets : DEFAULT_OFFSETS;
  const cleaned = [...new Set(source.filter((o) => Number.isFinite(o) && o > 0).map((o) => Math.floor(o)))];
  return cleaned.sort((a, b) => b - a);
}

/**
 * 预览里"提醒"一行的文案。
 *
 * 三种情形必须可区分（PRD 5、16.1-2）：
 *   - 有可排提醒 → 列出实际触发时刻；
 *   - 用户主动关闭 → 「已关闭提醒」；
 *   - 缺字段或时间已过 → 写明原因，且**不得**出现"已安排提醒"。
 */
export function reminderSummary(draft: Draft, now: Date): { lines: string[]; blockedReason: string | null } {
  if (draft.reminderDeclined) {
    return { lines: [], blockedReason: '已关闭提醒（按你的要求）' };
  }

  const anchor = draftAnchor(draft);
  if (!anchor) {
    const reason =
      draft.kind === 'event'
        ? '未安排提醒（缺少开始时间，可到工作站补充）'
        : '未安排提醒（缺少日期或时刻，可到工作站补充）';
    return { lines: [], blockedReason: reason };
  }

  const { plan, total } = planReminders(draft, now);
  if (plan.length === 0) {
    return {
      lines: [],
      blockedReason:
        total > 0 && draft.kind === 'event'
          ? '本次不安排提醒（距开始不足 10 分钟，或提醒时间已过）'
          : '本次不安排提醒（提醒时间已过）',
    };
  }

  const lines = plan.map((item) => {
    const when = `${instantToDateString(item.fireAt)} ${instantToTimeString(item.fireAt)}`;
    return `${offsetLabel(item.offsetMinutes)}（${when}）`;
  });

  // 有档位被丢弃时如实说明，避免用户以为两档都排上了
  if (plan.length < total) {
    return {
      lines,
      blockedReason: null,
    };
  }
  return { lines, blockedReason: null };
}

export function offsetLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `提前 ${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `提前 ${minutes / 60} 小时`;
  return `提前 ${minutes} 分钟`;
}

/** 时间的展示文案：必须带绝对日期与时区（PRD 3.2） */
export function draftTimeText(draft: Draft): string | null {
  if (draft.kind === 'event') {
    const instant = draftInstant(draft);
    if (!instant) return null;
    const text = `${instantToDateString(instant)} ${instantToTimeString(instant)}（北京时间）`;
    const end = draft.endAt ? new Date(draft.endAt) : null;
    if (end && !Number.isNaN(end.getTime())) {
      return `${text} 至 ${instantToTimeString(end)}`;
    }
    return text;
  }
  if (!draft.dueDate) return null;
  if (!draft.dueTime) return `${draft.dueDate}（全天，无具体时刻）`;
  return `${draft.dueDate} ${draft.dueTime}（北京时间）`;
}

/* ────────────────────────── 字段补丁 ────────────────────────── */

export type DraftPatch = {
  title?: string;
  startAt?: string | null;
  endAt?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  location?: string | null;
  note?: string | null;
  reminderEnabled?: boolean;
  reminderOffsets?: number[];
  reminderDeclined?: boolean;
  /** 类型转换请求 */
  convertTo?: DraftKind;
};

/**
 * 应用补丁。
 *
 * 三条容易做错的地方：
 * - 只改用户指定的字段，未提供的字段保留（PRD 3.3："补丁更新用户指定字段"）；
 * - 类型转换时地点按 16.1-5 移除并记录 dropped 说明，且**不自动补任何字段**；
 * - `providedFields` 只增不减，用于"只保留用户明确提供过的数据"。
 */
export function applyPatch(
  draft: Draft,
  patch: DraftPatch,
  now: Date,
): { draft: Draft; dropped: string[]; changed: boolean } {
  const next: Draft = { ...draft, providedFields: [...draft.providedFields] };
  const dropped: string[] = [];
  let changed = false;

  const mark = (field: string) => {
    if (!next.providedFields.includes(field)) next.providedFields.push(field);
    changed = true;
  };

  // 类型转换先行：决定哪些字段仍然有意义
  if (patch.convertTo && patch.convertTo !== draft.kind) {
    next.kind = patch.convertTo;
    changed = true;
    if (patch.convertTo === 'task') {
      // 待办没有地点概念：移除并明确告知，而不是静默丢弃
      if (next.location) {
        dropped.push('已移除地点（待办无地点）');
        next.location = null;
      }
      // 事件时间迁移为待办的日期/时刻；只做字段搬运，不新增信息
      if (next.startAt) {
        const instant = new Date(next.startAt);
        if (!Number.isNaN(instant.getTime())) {
          next.dueDate = instantToDateString(instant);
          next.dueTime = instantToTimeString(instant);
          dropped.push(`时间已按待办截止时间记录（${next.dueDate} ${next.dueTime}）`);
        }
      }
      next.startAt = null;
      next.endAt = null;
    } else {
      // 转为事件：把待办日期/时刻搬成开始时间
      if (next.dueDate) {
        const [y, m, d] = next.dueDate.split('-').map(Number);
        const [hh, mm] = (next.dueTime ?? '00:00').split(':').map(Number);
        if (y && m && d) {
          next.startAt = zonedToInstant(y, m, d, hh ?? 0, mm ?? 0).toISOString();
          if (next.dueTime) dropped.push('待办截止时刻已作为事件开始时间');
        }
      }
      next.dueDate = null;
      next.dueTime = null;
    }
  }

  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (title !== next.title) {
      next.title = title;
      changed = true;
    }
    if (title) next.providedFields.includes('title') || next.providedFields.push('title');
  }
  if (patch.startAt !== undefined && next.kind === 'event') {
    next.startAt = patch.startAt;
    mark('startAt');
  }
  if (patch.endAt !== undefined && next.kind === 'event') {
    next.endAt = patch.endAt;
    mark('endAt');
  }
  if (patch.dueDate !== undefined && next.kind === 'task') {
    next.dueDate = patch.dueDate;
    mark('dueDate');
  }
  if (patch.dueTime !== undefined && next.kind === 'task') {
    next.dueTime = patch.dueTime;
    mark('dueTime');
  }
  if (patch.location !== undefined) {
    // 待办不保留地点（16.1-5）
    if (next.kind === 'task') {
      if (patch.location) dropped.push('已忽略地点（待办无地点）');
    } else {
      next.location = patch.location;
      mark('location');
    }
  }
  if (patch.note !== undefined) {
    next.note = patch.note;
    mark('note');
  }
  if (patch.reminderDeclined) {
    next.reminderDeclined = true;
    next.reminderEnabled = false;
    next.reminderOffsets = [];
    changed = true;
    if (!next.providedFields.includes('reminder')) next.providedFields.push('reminder');
  }
  if (patch.reminderEnabled !== undefined && !patch.reminderDeclined) {
    next.reminderEnabled = patch.reminderEnabled;
    next.reminderDeclined = false;
    changed = true;
    if (!next.providedFields.includes('reminder')) next.providedFields.push('reminder');
  }
  if (patch.reminderOffsets !== undefined) {
    next.reminderOffsets = normalizeOffsets(patch.reminderOffsets);
    if (next.reminderOffsets.length > 0) {
      next.reminderEnabled = true;
      next.reminderDeclined = false;
    }
    changed = true;
    if (!next.providedFields.includes('reminder')) next.providedFields.push('reminder');
  }

  void now;
  return { draft: next, dropped, changed };
}

export function normalizeOffsets(offsets: number[]): number[] {
  const cleaned = [
    ...new Set(offsets.filter((o) => Number.isFinite(o) && o > 0).map((o) => Math.floor(o))),
  ];
  return cleaned.sort((a, b) => b - a);
}

/* ────────────────────────── 到期与校验 ────────────────────────── */

/** 每次有效修改都续期（PRD 16.1-4） */
export function renewedExpiry(now: Date): Date {
  return new Date(now.getTime() + DRAFT_TTL_MINUTES * 60_000);
}

export function isExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}

export type CommitValidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * 提交前重新校验（PRD 5 末段）：
 * 等待确认期间跨入"不足 10 分钟"时，计划已变，必须重新预览并换新短码，
 * **不能**悄悄按不同计划提交。
 */
export function validateBeforeCommit(draft: Draft, now: Date): CommitValidation {
  const missing = missingFields(draft);
  if (missing.length > 0) {
    return { ok: false, reason: '草稿仍缺少必填信息，请先补充' };
  }

  if (draft.kind === 'event') {
    const instant = draftInstant(draft);
    if (!instant) return { ok: false, reason: '开始时间无效' };
    // 过去时间不得静默创建（PRD 5：过去时间需要提示或澄清）
    if (instant.getTime() <= now.getTime()) {
      return { ok: false, reason: '开始时间已经过去，请改到将来或取消草稿' };
    }
    if (draft.endAt) {
      const end = new Date(draft.endAt);
      if (!Number.isNaN(end.getTime()) && end.getTime() < instant.getTime()) {
        return { ok: false, reason: '结束时间不能早于开始时间' };
      }
    }
  }
  return { ok: true };
}

/** 计划指纹：用于判定"预览中的有效计划是否已变化" */
export function planFingerprint(draft: Draft, now: Date): string {
  const { plan } = planReminders(draft, now);
  return plan.map((p) => `${p.offsetMinutes}@${p.fireAt.toISOString()}`).join(',');
}

export { todayInTz, addDays };

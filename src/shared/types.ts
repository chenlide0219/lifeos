/**
 * 前后端共享的 API 契约类型。
 * 前端只依赖本文件，不引入任何服务端代码。
 */

export type ApiError = {
  error: string;
  message: string;
};

export type SessionUserDto = {
  id: number;
  username: string;
  /** 能否管理账号（新增/禁用/重置）。不代表能看别人的业务数据——数据一律按用户隔离 */
  isAdmin: boolean;
  /** 为真时前端必须先把用户送到改密页；后端也会拒绝其它接口（403 password_change_required） */
  mustChangePassword: boolean;
};

export type AuthResponse = {
  user: SessionUserDto;
};

export type HealthResponse = {
  status: 'ok' | 'degraded';
  db: 'up' | 'down';
  latencyMs?: number;
  uptimeSeconds?: number;
  memoryMb?: number;
  time?: string;
  error?: string;
};

/** 统一日历的条目类型（PRD FR-04） */
export type CalendarItemType = 'event' | 'task' | 'subscription';

/** 通知任务状态（PRD FR-07） */
export type NotificationStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'missed';

/** 订阅生命周期（PRD FR-05） */
export type SubscriptionStatus =
  | 'trial'
  | 'active'
  | 'paused'
  | 'auto_renew_off'
  | 'ended';

/** 计费周期（PRD FR-05） */
export type BillingPeriod = 'monthly' | 'quarterly' | 'yearly' | 'custom_days' | 'lifetime';

/** 预计账单状态：预计账单永不自动转为真实支出（PRD FR-06） */
export type ExpectedBillStatus = 'expected' | 'confirmed' | 'skipped' | 'cancelled';

/** 语音 → AI 结构化草稿（PRD FR-03） */
export type AiDraft = {
  kind: 'event' | 'task';
  title: string;
  /** 事件开始/结束：ISO 8601 带时区偏移 */
  start_at: string | null;
  end_at: string | null;
  /** 待办的截止日期与时刻分开存，禁止把全天项目当成 UTC 午夜 */
  due_date: string | null;
  due_time: string | null;
  location: string | null;
  note: string | null;
  reminder_enabled: boolean;
  reminder_offsets: number[];
  /** 含糊时间必须回问用户，禁止擅自生成具体时刻（PRD FR-03.4） */
  ambiguities: string[];
};

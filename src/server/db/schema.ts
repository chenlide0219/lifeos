/**
 * Life OS V1 — 数据模型（PRD 第 5 节）
 *
 * 约定：
 * - 时间型数据用 timestamptz 按 UTC 存储，展示时按用户时区（Asia/Shanghai）换算。
 * - 日期型数据（全天待办、订阅扣费日）用 date，**不**当作 UTC 午夜处理。
 * - 金额一律 numeric(DECIMAL)，禁止二进制浮点。
 */
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/* ────────────────────────── 账户与会话 ────────────────────────── */

export const adminUsers = pgTable('admin_users', {
  id: serial('id').primaryKey(),
  username: varchar('username', { length: 64 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: integer('user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    /** 仅存 token 的 SHA-256，明文只存在于浏览器 Cookie */
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

/** 敏感操作二次验证与登录限速的审计记录 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => adminUsers.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 64 }).notNull(),
    detail: jsonb('detail'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_logs_created_idx').on(t.createdAt)],
);

/* ────────────────────────── 事件与待办 ────────────────────────── */

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: varchar('title', { length: 200 }).notNull(),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }),
    location: text('location'),
    note: text('note'),
    /** active | cancelled */
    status: varchar('status', { length: 16 }).notNull().default('active'),
    /** manual | voice */
    source: varchar('source', { length: 16 }).notNull().default('manual'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('events_start_idx').on(t.startAt), index('events_status_idx').on(t.status)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: varchar('title', { length: 200 }).notNull(),
    /** 全天待办只有日期 */
    dueDate: date('due_date'),
    /** 精确到分钟的待办才有时刻；为空时按全天处理 */
    dueTime: time('due_time'),
    /** todo | done | cancelled */
    status: varchar('status', { length: 16 }).notNull().default('todo'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    note: text('note'),
    source: varchar('source', { length: 16 }).notNull().default('manual'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('tasks_due_idx').on(t.dueDate), index('tasks_status_idx').on(t.status)],
);

/* ────────────────────────── 订阅与财务 ────────────────────────── */

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 200 }).notNull(),
    planName: varchar('plan_name', { length: 200 }),
    /** trial | active | paused | auto_renew_off | ended */
    status: varchar('status', { length: 24 }).notNull().default('active'),
    price: numeric('price', { precision: 12, scale: 2 }),
    currency: varchar('currency', { length: 3 }).notNull().default('CNY'),
    /** monthly | quarterly | yearly | custom_days | lifetime */
    billingPeriod: varchar('billing_period', { length: 16 }).notNull().default('monthly'),
    /** 仅 custom_days 使用 */
    billingIntervalDays: integer('billing_interval_days'),
    /** 计费锚点：决定每次扣费的“日” */
    anchorDate: date('anchor_date'),
    nextBillingDate: date('next_billing_date'),
    serviceEndDate: date('service_end_date'),
    autoRenew: boolean('auto_renew').notNull().default(true),
    paymentChannel: varchar('payment_channel', { length: 64 }),
    paymentMethod: varchar('payment_method', { length: 64 }),
    category: varchar('category', { length: 64 }),
    note: text('note'),
    /** 提醒与是否出现在日历中彼此独立（PRD FR-05） */
    reminderEnabled: boolean('reminder_enabled').notNull().default(false),
    reminderDaysBefore: integer('reminder_days_before').notNull().default(3),
    reminderTime: time('reminder_time').default('09:00'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('subscriptions_status_idx').on(t.status),
    index('subscriptions_next_billing_idx').on(t.nextBillingDate),
  ],
);

/** 历次调价及生效日；调价不追改历史付款 */
export const subscriptionPriceHistory = pgTable(
  'subscription_price_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    price: numeric('price', { precision: 12, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    effectiveFrom: date('effective_from').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('price_history_sub_idx').on(t.subscriptionId, t.effectiveFrom)],
);

/** 预计账单：永不自动视为已付款（PRD FR-06） */
export const expectedBills = pgTable(
  'expected_bills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    plannedDate: date('planned_date').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    /** expected | confirmed | skipped | cancelled */
    status: varchar('status', { length: 16 }).notNull().default('expected'),
    /** auto | manual | imported */
    generatedBy: varchar('generated_by', { length: 16 }).notNull().default('auto'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('expected_bills_sub_date_uq').on(t.subscriptionId, t.plannedDate),
    index('expected_bills_status_idx').on(t.status),
  ],
);

/** 实际付款流水（含退款，统计时扣减净支出） */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
      onDelete: 'set null',
    }),
    expectedBillId: uuid('expected_bill_id').references(() => expectedBills.id, {
      onDelete: 'set null',
    }),
    paidAt: date('paid_at').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    /** 汇率快照：带日期来源，不可用时允许手动并标记为估算 */
    fxRate: numeric('fx_rate', { precision: 18, scale: 8 }),
    fxRateSource: varchar('fx_rate_source', { length: 64 }),
    fxRateDate: date('fx_rate_date'),
    cnyAmount: numeric('cny_amount', { precision: 12, scale: 2 }),
    isRefund: boolean('is_refund').notNull().default(false),
    isEstimatedFx: boolean('is_estimated_fx').notNull().default(false),
    paymentChannel: varchar('payment_channel', { length: 64 }),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('payments_paid_at_idx').on(t.paidAt), index('payments_sub_idx').on(t.subscriptionId)],
);

/** CSV 导入批次：文件摘要、字段映射与结果可追溯 */
export const csvImportBatches = pgTable('csv_import_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  filename: varchar('filename', { length: 255 }).notNull(),
  fileHash: varchar('file_hash', { length: 64 }),
  mapping: jsonb('mapping'),
  totalRows: integer('total_rows').notNull().default(0),
  okRows: integer('ok_rows').notNull().default(0),
  errorRows: integer('error_rows').notNull().default(0),
  errors: jsonb('errors'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ────────────────────────── 通知中心 ────────────────────────── */

export const notificationRules = pgTable(
  'notification_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** event | subscription */
    subjectType: varchar('subject_type', { length: 16 }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    /** wechat（经 NotificationProvider 隔离实现） */
    channel: varchar('channel', { length: 16 }).notNull().default('wechat'),
    enabled: boolean('enabled').notNull().default(true),
    /** 事件用：提前分钟数数组，如 [60, 10] */
    offsetsMinutes: jsonb('offsets_minutes'),
    /** 订阅用：提前天数 + 发送时刻 */
    daysBefore: integer('days_before'),
    sendTime: time('send_time'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notification_rules_subject_uq').on(t.subjectType, t.subjectId, t.channel),
    index('notification_rules_subject_idx').on(t.subjectType, t.subjectId),
  ],
);

export const notificationJobs = pgTable(
  'notification_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ruleId: uuid('rule_id').references(() => notificationRules.id, { onDelete: 'cascade' }),
    subjectType: varchar('subject_type', { length: 16 }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    fireAt: timestamp('fire_at', { withTimezone: true }).notNull(),
    /** pending | sending | sent | failed | cancelled | skipped | missed */
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    /** 幂等键：防止并发调度重复投递 */
    idempotencyKey: text('idempotency_key').notNull().unique(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    /** 租约：Worker 抢占后写入，超时可被其他实例回收 */
    leasedUntil: timestamp('leased_until', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notification_jobs_fire_idx').on(t.status, t.fireAt),
    index('notification_jobs_subject_idx').on(t.subjectType, t.subjectId),
  ],
);

export const notificationAttempts = pgTable(
  'notification_attempts',
  {
    id: serial('id').primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => notificationJobs.id, { onDelete: 'cascade' }),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
    success: boolean('success').notNull(),
    /** 脱敏后的错误，禁止写入完整 token 与会话凭证 */
    error: text('error'),
  },
  (t) => [index('notification_attempts_job_idx').on(t.jobId)],
);

/* ────────────────────────── 设置 ────────────────────────── */

export const settings = pgTable('settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

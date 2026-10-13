/**
 * Life OS V1 — 数据模型（PRD 第 5 节）
 *
 * 约定：
 * - 时间型数据用 timestamptz 按 UTC 存储，展示时按用户时区（Asia/Shanghai）换算。
 * - 日期型数据（全天待办、订阅扣费日）用 date，**不**当作 UTC 午夜处理。
 * - 金额一律 numeric(DECIMAL)，禁止二进制浮点。
 */
import { sql } from 'drizzle-orm';
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

/**
 * 账号表（原 `admin_users`，多用户改造后重命名为 `users`）。
 *
 * 单管理员曾是产品不变量，由常量表达式唯一索引在数据库层强制"至多一行"。
 * 多用户上线后该索引已删除（见迁移 0003）：仍然**不开放注册**，账号只能由
 * 管理界面或 CLI 显式创建，但允许多行。
 *
 * 保留的仍然是"安全的默认值"：
 * - `is_admin` 默认 false —— 新建账号默认没有账号管理权限，必须显式授权；
 * - `must_change_password` 默认 false —— 只有被管理员创建或重置过密码的账号才置为 true。
 */
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: varchar('username', { length: 64 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  /** 能否管理账号（新增/禁用/重置）。不是"能否看别人数据"——数据一律按用户隔离 */
  isAdmin: boolean('is_admin').notNull().default(false),
  /** 禁用时刻；非空即禁止登录，且历史会话在禁用时被立即清除 */
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  /**
   * 必须改密。为真时除「查自己是谁」「改密」「登出」外的接口一律拒绝，
   * 不能只靠前端跳转——否则一个直接调 API 的客户端就绕过了强制改密。
   */
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
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
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
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
    /**
     * 失败类别，供界面区分"需要人工核实"与"可直接放弃"：
     * retryable | rejected | needs_human | unknown | exhausted
     * unknown 表示无法确认下游是否已接受（HTTP 200 但无可靠回执、超时、发送中中断），
     * 按政策不自动重发，需人工核实手机是否已收到。
     */
    failureKind: varchar('failure_kind', { length: 16 }),
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

/* ────────────────────────── 微信创建与查询（V1.1） ────────────────────────── */

/**
 * 入站消息持久化（PRD 8.1）。
 *
 * 设计要点（决定了整个接收侧的重构方向）：
 * - **先落库再处理**：网络轮询在事务外；"插入消息 + 推进游标 + 刷新上下文"在
 *   同一短事务内提交。原实现把上下文更新放在同步回调里，无法在其中调用模型，
 *   所以必须把消息先持久化，处理流程移到事务之外。
 * - 唯一约束建在「绑定代际 + 提供方消息 ID」上，而不是内存里的 seen 数组——
 *   后者重启即失忆，且长度有限会漏判重复。
 * - `parse_basis_at` 冻结该条消息的解析时间基准：重试时不得用"当前时间"
 *   重新解释"明天"（PRD 5）。
 */
export const wechatInbox = pgTable(
  'wechat_inbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bindingGeneration: uuid('binding_generation').notNull(),
    /** 提供方消息 ID；缺失时由内容哈希兜底（见 lib 中的派生函数） */
    providerMessageId: text('provider_message_id').notNull(),
    fromUserId: text('from_user_id').notNull(),
    /** 第一阶段只处理文本 */
    messageType: integer('message_type').notNull().default(1),
    text: text('text').notNull(),
    contextTokenEnc: text('context_token_enc'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    providerTime: timestamp('provider_time', { withTimezone: true }),
    /** 冻结的解析基准（入站时刻），重试不得改写 */
    parseBasisAt: timestamp('parse_basis_at', { withTimezone: true }).notNull(),
    /** pending | processing | done | failed | dead */
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    /** 可恢复处理租约；超时可被回收 */
    leasedUntil: timestamp('leased_until', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    lastError: text('last_error'),
    /** 下次可处理的时刻（退避） */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    /** 关联的创建/查询操作（若有） */
    operationId: uuid('operation_id'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    /** 正文保留期（PRD 16.1-4：7 天），到期只清正文、保留终态凭据 */
    purgeAfter: timestamp('purge_after', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('wechat_inbox_msg_uq').on(t.bindingGeneration, t.providerMessageId),
    index('wechat_inbox_claim_idx').on(t.status, t.nextAttemptAt),
    index('wechat_inbox_purge_idx').on(t.purgeAfter),
  ],
);

/**
 * 创建/查询操作（PRD 8.1）。
 *
 * 一个绑定会话**最多一个活动创建操作**（含缺字段、待确认、提交占用），
 * 由下方 `wechat_operations_active_uq` 偏唯一索引在数据库层保证，
 * 不依赖应用判断——应用判断在并发与重启面前不可靠。
 */
export const wechatOperations = pgTable(
  'wechat_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bindingGeneration: uuid('binding_generation').notNull(),
    /** create | query */
    kind: varchar('kind', { length: 16 }).notNull().default('create'),
    /** 当前草稿类型；仅 kind=create 时有意义 */
    draftKind: varchar('draft_kind', { length: 16 }),
    status: varchar('status', { length: 16 }).notNull().default('awaiting_fields'),
    /** 每次有效修改递增；短码绑定该版本 */
    version: integer('version').notNull().default(1),
    /** 确认短码；由服务端生成，模型不得设置 */
    shortCode: varchar('short_code', { length: 16 }),
    /** 归一化草稿（含 missingFields 与 providedFields） */
    draft: jsonb('draft'),
    /** 缺字段时的追问内容 */
    missingFields: jsonb('missing_fields'),
    /** 触发该操作的消息 */
    sourceInboxId: uuid('source_inbox_id'),
    /** 幂等键：重启与重复确认复用同一键 */
    idempotencyKey: text('idempotency_key').notNull().unique(),
    /** 最近一次预览的发送状态（unknown 时不得把裸确认当同意） */
    previewRevision: uuid('preview_revision'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    /** 提交后的事项 ID（事件或待办） */
    resultSubjectType: varchar('result_subject_type', { length: 16 }),
    resultSubjectId: uuid('result_subject_id'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 同一绑定代际下至多一个活动创建操作（终态为 committed/cancelled/expired）
    uniqueIndex('wechat_operations_active_uq')
      .on(t.bindingGeneration)
      .where(sql`status in ('awaiting_fields','pending_confirm','committing')`),
    index('wechat_operations_gen_idx').on(t.bindingGeneration, t.createdAt),
    index('wechat_operations_recent_idx').on(t.bindingGeneration, t.status, t.updatedAt),
  ],
);

/**
 * 回复/通知出站队列（PRD 8.1、7.3）。
 *
 * 与 notification_jobs 分开的原因：
 * - 通知任务面向"事项提醒"，有重试与三态语义；
 * - 微信回复面向"一次对话应答"，`binding_generation + 操作版本` 变更后
 *   **必须作废**（换绑或草稿被替代后的旧回复不得发出）。
 * 发送计数仍统一走既有 8/10 窗口实现（PRD 16.2）。
 */
export const wechatOutbox = pgTable(
  'wechat_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bindingGeneration: uuid('binding_generation').notNull(),
    operationId: uuid('operation_id'),
    sourceInboxId: uuid('source_inbox_id'),
    /** 生成该回复时的操作版本；版本变化即作废 */
    operationVersion: integer('operation_version'),
    /** preview | created | cancelled | expired | error | help | query | pending | recent | notice */
    replyType: varchar('reply_type', { length: 16 }).notNull(),
    /** 正文；7 天后清理，不破坏终态审计 */
    body: text('body').notNull(),
    /** 去重键：防止同一次应答重复入队 */
    dedupeKey: text('dedupe_key').notNull().unique(),
    /** pending | sending | sent | failed | suppressed | cancelled */
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    leasedUntil: timestamp('leased_until', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    /** 结果未知：不自动重发（沿用三态策略） */
    failureKind: varchar('failure_kind', { length: 16 }),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    purgeAfter: timestamp('purge_after', { withTimezone: true }),
  },
  (t) => [
    index('wechat_outbox_claim_idx').on(t.status, t.nextAttemptAt),
    index('wechat_outbox_gen_idx').on(t.bindingGeneration),
    index('wechat_outbox_purge_idx').on(t.purgeAfter),
  ],
);

/* ────────────────────────── 设置 ────────────────────────── */

/**
 * **全局**键值设置。
 *
 * ⚠️ 多用户下的取舍：这个表是全库共享的，**不得**用来存"每个用户各自的偏好"。
 * 曾经误把 `theme` / `timezone` / `calendar.defaultView` 播种在这里，但那三个键
 * 从来没有被任何代码读取过（主题实际存在前端 localStorage，时区来自 env `TZ`），
 * 属于会误导后来者的死数据，已在多用户改造中停止播种。
 *
 * 用户级配置的正确位置是 `users` 行上的列，或带 `user_id` 的专属表；
 * 本表只保留真正全局的东西（例如后续可能出现的系统级开关）。
 */
export const settings = pgTable('settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

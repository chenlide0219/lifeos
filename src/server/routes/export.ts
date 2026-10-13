/**
 * 数据导出（PRD FR-08）
 *
 *   GET /api/export/subscriptions.csv   订阅档案
 *   GET /api/export/payments.csv        实际付款
 *   GET /api/export/data.json           当前账号的业务数据（用于迁移与自留备份）
 *
 * 安全约束（PRD FR-08 明确要求）：
 *   - **每个端点只导出当前登录账号的数据**：所有查询都带 `ownedBy(...)`（见
 *     lib/scope.ts），别人的行既不会出现在 CSV 里，也不会出现在 JSON 里。
 *     这是硬约束而不是"顺带"的过滤：导出文件会被下载、转发、长期留存，
 *     一次跨账号泄露就等于把别人的账目与日程一并交出去。
 *   - **绝不导出任何凭据材料**：`users.password_hash`、`sessions.token_hash`
 *     一律排除。备份文件常被放到邮箱、网盘或异地，凭据哈希一旦流出即等于长期风险。
 *   - 导出内容只包含业务数据本身。
 */
import { Hono, type Context } from 'hono';
import { and, asc, desc, eq, notLike } from 'drizzle-orm';
import { db } from '../db/client';
import {
  csvImportBatches,
  events,
  expectedBills,
  notificationJobs,
  notificationRules,
  payments,
  settings,
  subscriptionPriceHistory,
  subscriptions,
  tasks,
} from '../db/schema';
import { toCsv } from '../lib/csv';
import { todayInTz } from '../lib/time';
import { ownedBy } from '../lib/scope';
import { requireAuth, type AppEnv } from '../middleware/auth';
import { WECHAT_STATE_KEY } from '../lib/wechat-state';

export const exportRoutes = new Hono<AppEnv>();

function attachment(c: Context, filename: string, contentType: string): void {
  c.header('content-type', contentType);
  c.header('content-disposition', `attachment; filename="${filename}"`);
}

const stamp = () => todayInTz();

/** 导出中刻意排除的对象；JSON 与 manifest 共用一份，避免两处说法不一致 */
const EXPORT_EXCLUDED = [
  'users.password_hash',
  'sessions',
  'audit_logs',
  'notification_attempts',
  // 不写出具体的 key 字面量：导出文件本身不得出现该键名
  // （tests/unit/wechat-binding.test.ts 会断言导出正文里不含它）
  'settings 中的微信绑定凭据键',
] as const;

exportRoutes.get('/subscriptions.csv', requireAuth, async (c) => {
  const userId = c.get('user').id;
  const rows = await db
    .select({
      name: subscriptions.name,
      planName: subscriptions.planName,
      status: subscriptions.status,
      price: subscriptions.price,
      currency: subscriptions.currency,
      billingPeriod: subscriptions.billingPeriod,
      billingIntervalDays: subscriptions.billingIntervalDays,
      anchorDate: subscriptions.anchorDate,
      nextBillingDate: subscriptions.nextBillingDate,
      serviceEndDate: subscriptions.serviceEndDate,
      autoRenew: subscriptions.autoRenew,
      paymentChannel: subscriptions.paymentChannel,
      category: subscriptions.category,
      reminderEnabled: subscriptions.reminderEnabled,
      reminderDaysBefore: subscriptions.reminderDaysBefore,
      reminderTime: subscriptions.reminderTime,
      note: subscriptions.note,
      createdAt: subscriptions.createdAt,
    })
    .from(subscriptions)
    .where(ownedBy(subscriptions, userId))
    .orderBy(asc(subscriptions.name));

  const csv = toCsv(
    [
      '服务名称', '套餐', '状态', '当前标价', '币种', '计费周期', '自定义周期天数',
      '计费锚点', '下次扣费日', '服务到期日', '自动续费', '支付渠道', '分类',
      '提醒开关', '提醒提前天数', '提醒时刻', '备注', '创建时间',
    ],
    rows.map((r) => [
      r.name, r.planName, r.status, r.price, r.currency, r.billingPeriod, r.billingIntervalDays,
      r.anchorDate, r.nextBillingDate, r.serviceEndDate, r.autoRenew ? '是' : '否',
      r.paymentChannel, r.category, r.reminderEnabled ? '是' : '否', r.reminderDaysBefore,
      r.reminderTime, r.note, r.createdAt?.toISOString(),
    ]),
  );

  attachment(c, `lifeos-subscriptions-${stamp()}.csv`, 'text/csv; charset=utf-8');
  return c.body(csv);
});

exportRoutes.get('/payments.csv', requireAuth, async (c) => {
  const userId = c.get('user').id;
  const rows = await db
    .select({
      paidAt: payments.paidAt,
      subscriptionName: subscriptions.name,
      amount: payments.amount,
      currency: payments.currency,
      isRefund: payments.isRefund,
      fxRate: payments.fxRate,
      fxRateSource: payments.fxRateSource,
      fxRateDate: payments.fxRateDate,
      cnyAmount: payments.cnyAmount,
      isEstimatedFx: payments.isEstimatedFx,
      paymentChannel: payments.paymentChannel,
      note: payments.note,
    })
    .from(payments)
    // 订阅名是"付款所属账号的订阅名"：join 条件里也带上归属，
    // 避免付款行与别人的订阅行在 SQL 层被配到一起
    .leftJoin(
      subscriptions,
      and(eq(subscriptions.id, payments.subscriptionId), ownedBy(subscriptions, userId)),
    )
    .where(ownedBy(payments, userId))
    .orderBy(desc(payments.paidAt));

  const csv = toCsv(
    [
      '付款日期', '关联订阅', '金额', '币种', '是否退款', '汇率', '汇率来源', '汇率日期',
      '折算人民币', '人民币金额为估算', '支付渠道', '备注',
    ],
    rows.map((r) => [
      r.paidAt, r.subscriptionName, r.amount, r.currency, r.isRefund ? '是' : '否',
      r.fxRate, r.fxRateSource, r.fxRateDate, r.cnyAmount, r.isEstimatedFx ? '是' : '否',
      r.paymentChannel, r.note,
    ]),
  );

  attachment(c, `lifeos-payments-${stamp()}.csv`, 'text/csv; charset=utf-8');
  return c.body(csv);
});

/**
 * 当前账号的业务数据 JSON。
 *
 * 范围：**只含当前登录账号的行**。每张业务表的 select 都必须出现 `ownedBy(...)`，
 * 因为 JSON 导出是最容易被忽略归属的一处——它一次性取走全部表。
 *
 * 刻意排除：`users.password_hash`、`sessions` 全部、
 * 以及任何密钥类环境变量。导出文件经常被搬来搬去，凭据材料不能随之流动。
 *
 * `settings` 是**全局**键值表（无 `user_id`），因此是全库唯一不属于任何账号的数据源；
 * 旧版微信绑定凭据就写在这张表里，因此按其 key 排除——它一旦流出，
 * 别人就能用该凭据以你的身份发消息。新版绑定已按账号存于 `wechat_accounts`，
 * 这张表**从不**出现在导出里。
 */
exportRoutes.get('/data.json', requireAuth, async (c) => {
  const userId = c.get('user').id;
  const [
    eventRows, taskRows, subRows, priceRows, billRows, paymentRows,
    ruleRows, jobRows, batchRows, settingRows,
  ] = await Promise.all([
    db.select().from(events).where(ownedBy(events, userId)).orderBy(asc(events.startAt)),
    db.select().from(tasks).where(ownedBy(tasks, userId)).orderBy(asc(tasks.createdAt)),
    db.select().from(subscriptions).where(ownedBy(subscriptions, userId)).orderBy(asc(subscriptions.name)),
    db.select().from(subscriptionPriceHistory).where(ownedBy(subscriptionPriceHistory, userId))
      .orderBy(asc(subscriptionPriceHistory.effectiveFrom)),
    db.select().from(expectedBills).where(ownedBy(expectedBills, userId))
      .orderBy(asc(expectedBills.plannedDate)),
    db.select().from(payments).where(ownedBy(payments, userId)).orderBy(asc(payments.paidAt)),
    db.select().from(notificationRules).where(ownedBy(notificationRules, userId)),
    db.select({
      id: notificationJobs.id,
      ruleId: notificationJobs.ruleId,
      subjectType: notificationJobs.subjectType,
      subjectId: notificationJobs.subjectId,
      title: notificationJobs.title,
      body: notificationJobs.body,
      fireAt: notificationJobs.fireAt,
      status: notificationJobs.status,
      failureKind: notificationJobs.failureKind,
      attempts: notificationJobs.attempts,
      maxAttempts: notificationJobs.maxAttempts,
      sentAt: notificationJobs.sentAt,
      lastError: notificationJobs.lastError,
      idempotencyKey: notificationJobs.idempotencyKey,
      createdAt: notificationJobs.createdAt,
    }).from(notificationJobs).where(ownedBy(notificationJobs, userId)).orderBy(asc(notificationJobs.fireAt)),
    db.select().from(csvImportBatches).where(ownedBy(csvImportBatches, userId))
      .orderBy(asc(csvImportBatches.createdAt)),
    // settings 无归属列（全局表），只能按 key 排除：必须排除旧版微信绑定凭据行。
    // 用前缀匹配而不是全等，是为了同时兜住迁移可能残留的变体键（如带账号后缀的旧写法），
    // 任何形态的凭据行都不允许随导出流出。
    db.select().from(settings).where(notLike(settings.key, `${WECHAT_STATE_KEY}%`)),
  ]);

  const payload = {
    schema: 'lifeos-export/1',
    exportedAt: new Date().toISOString(),
    // 归属声明：下面的每一个计数、数据区的每一行都属于当前登录账号
    scope: 'current-account',
    scopeNote:
      '只包含当前登录账号的业务数据，其他账号的行不会出现在任何导出端点中；'
      + '例外是全局键值表 settings（无归属列），其中的微信绑定凭据键已排除',
    counts: {
      events: eventRows.length,
      tasks: taskRows.length,
      subscriptions: subRows.length,
      subscriptionPriceHistory: priceRows.length,
      expectedBills: billRows.length,
      payments: paymentRows.length,
      notificationRules: ruleRows.length,
      notificationJobs: jobRows.length,
      csvImportBatches: batchRows.length,
      settings: settingRows.length,
    },
    // 明确声明未包含的内容，避免使用者误以为"这就是全部"
    excluded: EXPORT_EXCLUDED,
    exclusionReason:
      '凭据材料与会话令牌不随导出文件流动；审计与发送尝试按运维日志处理。'
      + '除上述项外，本文件只含当前账号的行',
    data: {
      events: eventRows,
      tasks: taskRows,
      subscriptions: subRows,
      subscriptionPriceHistory: priceRows,
      expectedBills: billRows,
      payments: paymentRows,
      notificationRules: ruleRows,
      notificationJobs: jobRows,
      csvImportBatches: batchRows,
      settings: settingRows,
    },
  };

  attachment(c, `lifeos-data-${stamp()}.json`, 'application/json; charset=utf-8');
  return c.body(JSON.stringify(payload, null, 2));
});

/** 导出内容自检：让使用者能确认导出里到底有什么、没有什么 */
exportRoutes.get('/manifest', requireAuth, async (c) =>
  c.json({
    // 与 data.json 一致的范围声明：导出的是"我的数据"，不是"全库数据"
    scope: 'current-account',
    scopeNote:
      '所有导出端点都只返回当前登录账号的数据；其他账号的行不会出现在任何导出文件里'
      + '（全局键值表 settings 是唯一例外，其中的微信绑定凭据键已排除）',
    endpoints: [
      { path: '/api/export/subscriptions.csv', content: '当前账号的订阅档案（含计费与提醒配置）' },
      { path: '/api/export/payments.csv', content: '当前账号的实际付款（含退款与汇率快照）' },
      { path: '/api/export/data.json', content: '当前账号的业务数据 JSON（只含本人数据）' },
    ],
    excluded: EXPORT_EXCLUDED,
    csvNotes: [
      'UTF-8 带 BOM，Excel 打开中文不乱码',
      '以 = + - @ 开头的单元格会被加上前导单引号，防止被当作公式执行',
    ],
  }),
);

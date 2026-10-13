/**
 * 数据导出（PRD FR-08）
 *
 *   GET /api/export/subscriptions.csv   订阅档案
 *   GET /api/export/payments.csv        实际付款
 *   GET /api/export/data.json           完整业务数据（用于迁移与自留备份）
 *
 * 安全约束（PRD FR-08 明确要求）：
 *   - **绝不导出任何凭据材料**：`users.password_hash`、`sessions.token_hash`
 *     一律排除。备份文件常被放到邮箱、网盘或异地，凭据哈希一旦流出即等于长期风险。
 *   - 导出内容只包含业务数据本身。
 */
import { Hono, type Context } from 'hono';
import { asc, desc, eq, ne } from 'drizzle-orm';
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
import { requireAuth, type AppEnv } from '../middleware/auth';
import { WECHAT_STATE_KEY } from '../lib/wechat-state';

export const exportRoutes = new Hono<AppEnv>();

function attachment(c: Context, filename: string, contentType: string): void {
  c.header('content-type', contentType);
  c.header('content-disposition', `attachment; filename="${filename}"`);
}

const stamp = () => todayInTz();

exportRoutes.get('/subscriptions.csv', requireAuth, async (c) => {
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
    .leftJoin(subscriptions, eq(subscriptions.id, payments.subscriptionId))
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
 * 完整业务数据 JSON。
 *
 * 刻意排除：`users.password_hash`、`sessions` 全部、
 * 以及任何密钥类环境变量。导出文件经常被搬来搬去，凭据材料不能随之流动。
 */
exportRoutes.get('/data.json', requireAuth, async (c) => {
  const [
    eventRows, taskRows, subRows, priceRows, billRows, paymentRows,
    ruleRows, jobRows, batchRows, settingRows,
  ] = await Promise.all([
    db.select().from(events).orderBy(asc(events.startAt)),
    db.select().from(tasks).orderBy(asc(tasks.createdAt)),
    db.select().from(subscriptions).orderBy(asc(subscriptions.name)),
    db.select().from(subscriptionPriceHistory).orderBy(asc(subscriptionPriceHistory.effectiveFrom)),
    db.select().from(expectedBills).orderBy(asc(expectedBills.plannedDate)),
    db.select().from(payments).orderBy(asc(payments.paidAt)),
    db.select().from(notificationRules),
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
    }).from(notificationJobs).orderBy(asc(notificationJobs.fireAt)),
    db.select().from(csvImportBatches).orderBy(asc(csvImportBatches.createdAt)),
    db.select().from(settings).where(ne(settings.key, WECHAT_STATE_KEY)),
  ]);

  const payload = {
    schema: 'lifeos-export/1',
    exportedAt: new Date().toISOString(),
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
    excluded: ['users.password_hash', 'sessions', 'audit_logs', 'notification_attempts'],
    exclusionReason: '凭据材料与会话令牌不随导出文件流动；审计与发送尝试按运维日志处理',
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
    endpoints: [
      { path: '/api/export/subscriptions.csv', content: '订阅档案（含计费与提醒配置）' },
      { path: '/api/export/payments.csv', content: '实际付款（含退款与汇率快照）' },
      { path: '/api/export/data.json', content: '完整业务数据 JSON' },
    ],
    excluded: ['users.password_hash', 'sessions', 'audit_logs', 'notification_attempts'],
    csvNotes: [
      'UTF-8 带 BOM，Excel 打开中文不乱码',
      '以 = + - @ 开头的单元格会被加上前导单引号，防止被当作公式执行',
    ],
  }),
);

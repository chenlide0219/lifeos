/**
 * 订阅档案 / 预计账单 / 实际付款 / 统计（PRD FR-05 / FR-06）
 *
 * 本模块守住的硬性不变量：
 *   1. **预计账单永不自动转为真实支出**：只有用户显式确认付款才会生成 payments 记录；
 *      生成账单、读取、统计都不会改变已付状态；
 *   2. 调价不得追改历史付款（价格历史单独记录，付款保留当时的金额与汇率快照）；
 *   3. 退款计入净支出的扣减，但仍是独立记录，不与支出混为一谈；
 *   4. 「预计」与「实付」两套口径分开返回，绝不混算。
 */
import { Hono } from 'hono';
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { expectedBills, payments, subscriptions, subscriptionPriceHistory } from '../db/schema';
import {
  generateExpectedBills,
  monthlyEquivalent,
  validateBillingConfig,
  type BillingConfig,
  type BillingPeriod,
} from '../lib/billing';
import { resolveCnyAmount } from '../lib/fx';
import { purgeSubjectNotifications, rebuildSubscriptionNotifications } from '../lib/scheduling';
import { todayInTz } from '../lib/time';
import {
  assertCurrency,
  optBoolean,
  optDateString,
  optString,
  optTimeString,
  parseUuid,
  reqString,
  ValidationError,
} from '../lib/validate';
import { requireAuth, type AppEnv } from '../middleware/auth';
import { guard } from './events';

export const subscriptionRoutes = new Hono<AppEnv>();

const SUB_FIELDS = {
  id: subscriptions.id,
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
  note: subscriptions.note,
  reminderEnabled: subscriptions.reminderEnabled,
  reminderDaysBefore: subscriptions.reminderDaysBefore,
  reminderTime: subscriptions.reminderTime,
  createdAt: subscriptions.createdAt,
  updatedAt: subscriptions.updatedAt,
};

const PERIODS: BillingPeriod[] = ['monthly', 'quarterly', 'yearly', 'custom_days', 'lifetime'];
const STATUSES = ['trial', 'active', 'paused', 'auto_renew_off', 'ended'] as const;

function toConfig(row: Record<string, unknown>): BillingConfig {
  return {
    price: (row.price as string | null) ?? null,
    currency: (row.currency as string) ?? 'CNY',
    billingPeriod: row.billingPeriod as BillingPeriod,
    billingIntervalDays: (row.billingIntervalDays as number | null) ?? null,
    anchorDate: (row.anchorDate as string | null) ?? null,
    nextBillingDate: (row.nextBillingDate as string | null) ?? null,
    serviceEndDate: (row.serviceEndDate as string | null) ?? null,
    autoRenew: Boolean(row.autoRenew),
    status: (row.status as BillingConfig['status']) ?? 'active',
  };
}

/** 读取档案并做业务校验，供写入路径复用 */
function readSubscriptionBody(body: Record<string, unknown>, { partial }: { partial: boolean }) {
  const patch: Record<string, unknown> = {};

  if (!partial || body.name !== undefined) patch.name = reqString(body.name, '服务名称', 200);
  if (!partial || body.price !== undefined) patch.price = optString(body.price, '价格', 32);
  if (!partial || body.currency !== undefined) {
    patch.currency = assertCurrency(optString(body.currency, '币种', 3) ?? 'CNY');
  }
  if (!partial || body.billingPeriod !== undefined) {
    const period = optString(body.billingPeriod, '计费周期', 16) ?? 'monthly';
    if (!PERIODS.includes(period as BillingPeriod)) throw new ValidationError('计费周期取值不合法');
    patch.billingPeriod = period;
  }
  if (!partial || body.anchorDate !== undefined) patch.anchorDate = optDateString(body.anchorDate, '计费锚点');
  // 下次预计扣费日：PRD FR-05 列为必要字段，用户需要能手工校正
  // （此前该字段未在此处理，传入会被静默丢弃——请求看着成功，值却没了）
  if (!partial || body.nextBillingDate !== undefined) {
    patch.nextBillingDate = optDateString(body.nextBillingDate, '下次扣费日');
  }
  if (!partial || body.serviceEndDate !== undefined) {
    patch.serviceEndDate = optDateString(body.serviceEndDate, '服务到期日');
  }
  if (!partial || body.autoRenew !== undefined) patch.autoRenew = optBoolean(body.autoRenew, '自动续费', true);
  if (!partial || body.status !== undefined) {
    const status = optString(body.status, '状态', 24) ?? 'active';
    if (!(STATUSES as readonly string[]).includes(status)) throw new ValidationError('订阅状态取值不合法');
    patch.status = status;
  }

  if (body.billingIntervalDays !== undefined) {
    const raw = body.billingIntervalDays;
    if (raw === null || raw === '') patch.billingIntervalDays = null;
    else if (typeof raw === 'number' && Number.isInteger(raw)) patch.billingIntervalDays = raw;
    else throw new ValidationError('自定义周期天数必须是整数');
  }
  if (body.planName !== undefined) patch.planName = optString(body.planName, '套餐名', 200);
  if (body.paymentChannel !== undefined) patch.paymentChannel = optString(body.paymentChannel, '支付渠道', 64);
  if (body.category !== undefined) patch.category = optString(body.category, '分类', 64);
  if (body.note !== undefined) patch.note = optString(body.note, '备注', 2000);
  if (body.reminderEnabled !== undefined) patch.reminderEnabled = optBoolean(body.reminderEnabled, '提醒开关', false);
  if (body.reminderDaysBefore !== undefined) {
    const raw = body.reminderDaysBefore;
    if (raw === null || raw === '') patch.reminderDaysBefore = 3;
    else if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 365) {
      patch.reminderDaysBefore = raw;
    } else {
      throw new ValidationError('提前天数必须是 0 到 365 之间的整数');
    }
  }
  if (body.reminderTime !== undefined) {
    patch.reminderTime = optTimeString(body.reminderTime, '提醒时刻') ?? '09:00';
  }

  return patch;
}

/** 依据档案生成未来 12 个月预计账单；已存在同日期账单则保留（不覆盖、不删除已确认记录） */
async function regenerateBills(subscriptionId: string): Promise<{ created: number; total: number }> {
  const [row] = await db.select(SUB_FIELDS).from(subscriptions).where(eq(subscriptions.id, subscriptionId)).limit(1);
  if (!row) throw new ValidationError('订阅不存在');

  const plans = generateExpectedBills(toConfig(row as unknown as Record<string, unknown>), { horizonMonths: 12 });
  if (plans.length === 0) return { created: 0, total: 0 };

  const existing = await db
    .select({ plannedDate: expectedBills.plannedDate })
    .from(expectedBills)
    .where(eq(expectedBills.subscriptionId, subscriptionId));
  const existingDates = new Set(existing.map((e) => e.plannedDate));

  const toInsert = plans.filter((p) => !existingDates.has(p.plannedDate));
  if (toInsert.length > 0) {
    await db
      .insert(expectedBills)
      .values(
        toInsert.map((p) => ({
          subscriptionId,
          plannedDate: p.plannedDate,
          amount: p.amount,
          currency: p.currency,
          status: 'expected',
          generatedBy: 'auto',
        })),
      )
      .onConflictDoNothing();
  }

  return { created: toInsert.length, total: existingDates.size + toInsert.length };
}

/* ────────────────────────── 订阅档案 ────────────────────────── */

subscriptionRoutes.get('/', requireAuth, async (c) =>
  guard(c, async () => {
    const rows = await db.select(SUB_FIELDS).from(subscriptions).orderBy(asc(subscriptions.name)).limit(300);
    return c.json({
      subscriptions: rows.map((r) => ({
        ...r,
        monthlyEquivalent: monthlyEquivalent(toConfig(r as unknown as Record<string, unknown>)),
      })),
    });
  }),
);

subscriptionRoutes.get('/summary', requireAuth, async (c) =>
  guard(c, async () => {
    const today = todayInTz();
    const rows = await db.select(SUB_FIELDS).from(subscriptions);

    let expectedMonthly = 0;
    const byCurrency: Record<string, number> = {};
    const upcoming: { id: string; name: string; date: string; amount: string; currency: string }[] = [];

    for (const row of rows) {
      const config = toConfig(row as unknown as Record<string, unknown>);
      const monthly = monthlyEquivalent(config);
      if (monthly) {
        expectedMonthly += Number(monthly);
        byCurrency[config.currency] = (byCurrency[config.currency] ?? 0) + Number(monthly);
      }

      const next = row.nextBillingDate;
      if (next && next >= today) {
        upcoming.push({
          id: row.id,
          name: row.name,
          date: next,
          amount: row.price ?? '0.00',
          currency: row.currency,
        });
      }
    }

    upcoming.sort((a, b) => a.date.localeCompare(b.date));

    // 实付口径：指定期间内已确认付款，退款扣减
    const paid = await db
      .select({
        currency: payments.currency,
        gross: sql<string>`coalesce(sum(case when ${payments.isRefund} then 0 else ${payments.amount} end), 0)::text`,
        refunds: sql<string>`coalesce(sum(case when ${payments.isRefund} then ${payments.amount} else 0 end), 0)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(payments)
      .groupBy(payments.currency);

    return c.json({
      // 口径 1：预计（按当前周期折算的月均），与实付严格分开
      expected: { monthlyByCurrency: byCurrency, monthlyTotalNote: '不同币种不直接相加，人民币汇总需汇率快照' },
      // 口径 2：实付净支出
      actual: paid.map((p) => ({
        currency: p.currency,
        gross: p.gross,
        refunds: p.refunds,
        net: (Number(p.gross) - Number(p.refunds)).toFixed(2),
        count: p.count,
      })),
      upcoming: upcoming.slice(0, 10),
      subscriptions: rows.length,
      expectedMonthly: expectedMonthly.toFixed(2),
      today,
    });
  }),
);

subscriptionRoutes.get('/:id', requireAuth, async (c) =>
  guard(c, async () => {
    const id = parseUuid(c.req.param('id'), '订阅 ID');
    const [row] = await db.select(SUB_FIELDS).from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
    if (!row) return c.json({ error: 'not_found', message: '订阅不存在' }, 404);

    const bills = await db
      .select()
      .from(expectedBills)
      .where(eq(expectedBills.subscriptionId, id))
      .orderBy(asc(expectedBills.plannedDate))
      .limit(60);

    const history = await db
      .select()
      .from(subscriptionPriceHistory)
      .where(eq(subscriptionPriceHistory.subscriptionId, id))
      .orderBy(desc(subscriptionPriceHistory.effectiveFrom));

    const paid = await db
      .select()
      .from(payments)
      .where(eq(payments.subscriptionId, id))
      .orderBy(desc(payments.paidAt))
      .limit(60);

    return c.json({ subscription: row, expectedBills: bills, priceHistory: history, payments: paid });
  }),
);

subscriptionRoutes.post('/', requireAuth, async (c) =>
  guard(c, async () => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: 'invalid_request', message: '请求体必须是 JSON' }, 400);

    const patch = readSubscriptionBody(body, { partial: false });

    const issues = validateBillingConfig({
      price: (patch.price as string | null) ?? null,
      billingPeriod: patch.billingPeriod as BillingPeriod,
      billingIntervalDays: (patch.billingIntervalDays as number | null) ?? null,
      anchorDate: (patch.anchorDate as string | null) ?? null,
      serviceEndDate: (patch.serviceEndDate as string | null) ?? null,
      autoRenew: Boolean(patch.autoRenew),
    });
    if (issues.length > 0) {
      return c.json({ error: 'invalid_request', message: issues[0]!.message, issues }, 400);
    }

    const [created] = await db
      .insert(subscriptions)
      .values(patch as typeof subscriptions.$inferInsert)
      .returning(SUB_FIELDS);

    // 首次价格写入价格历史，作为后续调价的基线
    if (created!.price) {
      await db.insert(subscriptionPriceHistory).values({
        subscriptionId: created!.id,
        price: created!.price,
        currency: created!.currency,
        effectiveFrom: created!.anchorDate ?? todayInTz(),
        note: '初始价格',
      });
    }

    const bills = await regenerateBills(created!.id);
    // 订阅提醒：每项独立配置通知开关、提前天数与发送时刻（PRD FR-05）
    const reminder = await rebuildSubscriptionNotifications(created!.id);
    return c.json({ subscription: created, expectedBills: bills, reminder }, 201);
  }),
);

subscriptionRoutes.patch('/:id', requireAuth, async (c) =>
  guard(c, async () => {
    const id = parseUuid(c.req.param('id'), '订阅 ID');
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: 'invalid_request', message: '请求体必须是 JSON' }, 400);

    const [current] = await db.select(SUB_FIELDS).from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
    if (!current) return c.json({ error: 'not_found', message: '订阅不存在' }, 404);

    const patch = readSubscriptionBody(body, { partial: true });
    if (Object.keys(patch).length === 0) {
      return c.json({ error: 'invalid_request', message: '没有需要修改的字段' }, 400);
    }

    const merged = { ...current, ...patch } as unknown as Record<string, unknown>;
    const issues = validateBillingConfig({
      price: (merged.price as string | null) ?? null,
      billingPeriod: merged.billingPeriod as BillingPeriod,
      billingIntervalDays: (merged.billingIntervalDays as number | null) ?? null,
      anchorDate: (merged.anchorDate as string | null) ?? null,
      serviceEndDate: (merged.serviceEndDate as string | null) ?? null,
      autoRenew: Boolean(merged.autoRenew),
    });
    if (issues.length > 0) {
      return c.json({ error: 'invalid_request', message: issues[0]!.message, issues }, 400);
    }

    const [updated] = await db
      .update(subscriptions)
      .set({ ...patch, updatedAt: new Date() } as Partial<typeof subscriptions.$inferInsert>)
      .where(eq(subscriptions.id, id))
      .returning(SUB_FIELDS);

    // 调价只记历史，**不追改已发生的付款**（PRD FR-06）
    if (patch.price !== undefined && patch.price !== current.price) {
      await db.insert(subscriptionPriceHistory).values({
        subscriptionId: id,
        price: (patch.price as string | null) ?? '0.00',
        currency: updated!.currency,
        effectiveFrom: todayInTz(),
        note: `由 ${current.price ?? '未设置'} 调整为 ${patch.price ?? '未设置'}`,
      });
    }

    // 未确认的预计账单按新规则重算；已确认/已跳过的记录保持不变
    await db
      .delete(expectedBills)
      .where(and(eq(expectedBills.subscriptionId, id), eq(expectedBills.status, 'expected')));
    const bills = await regenerateBills(id);
    // 扣费日或提醒设置变化后重建：旧提醒先失效，避免按旧日期发出
    const reminder = await rebuildSubscriptionNotifications(id);

    return c.json({ subscription: updated, expectedBills: bills, reminder });
  }),
);

subscriptionRoutes.delete('/:id', requireAuth, async (c) =>
  guard(c, async () => {
    const id = parseUuid(c.req.param('id'), '订阅 ID');
    const [existing] = await db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
    if (!existing) return c.json({ error: 'not_found', message: '订阅不存在' }, 404);

    // 先清理提醒（含未发送任务与规则），再删除订阅；付款记录保留（外键为 SET NULL），
    // 历史支出不得因删除订阅而消失
    await purgeSubjectNotifications('subscription', id);
    await db.delete(subscriptions).where(eq(subscriptions.id, id));
    return c.json({ ok: true });
  }),
);

/* ────────────────────────── 预计账单 ────────────────────────── */

subscriptionRoutes.get('/bills/list', requireAuth, async (c) =>
  guard(c, async () => {
    const statusParam = (c.req.query('status') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const where = statusParam.length > 0 ? inArray(expectedBills.status, statusParam) : undefined;

    const rows = await db
      .select({
        id: expectedBills.id,
        subscriptionId: expectedBills.subscriptionId,
        subscriptionName: subscriptions.name,
        plannedDate: expectedBills.plannedDate,
        amount: expectedBills.amount,
        currency: expectedBills.currency,
        status: expectedBills.status,
        generatedBy: expectedBills.generatedBy,
        note: expectedBills.note,
      })
      .from(expectedBills)
      .leftJoin(subscriptions, eq(subscriptions.id, expectedBills.subscriptionId))
      .where(where)
      .orderBy(asc(expectedBills.plannedDate))
      .limit(300);

    return c.json({ bills: rows });
  }),
);

/**
 * 确认预计账单已付款 —— **唯一**能把"预计"变成"实付"的入口。
 * 必须携带真实付款信息，同时生成独立的 payments 记录并关联账单（PRD FR-06）。
 */
subscriptionRoutes.post('/bills/:id/confirm', requireAuth, async (c) =>
  guard(c, async () => {
    const id = parseUuid(c.req.param('id'), '账单 ID');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const [bill] = await db.select().from(expectedBills).where(eq(expectedBills.id, id)).limit(1);
    if (!bill) return c.json({ error: 'not_found', message: '预计账单不存在' }, 404);

    // 只有「预计」状态才能确认付款：已确认会重复支出，已取消/已跳过代表已决定不产生这笔支出
    if (bill.status !== 'expected') {
      const reason =
        bill.status === 'confirmed'
          ? '该账单已确认付款，不能重复确认'
          : `该账单当前状态为「${bill.status}」，不能确认付款`;
      return c.json({ error: 'invalid_state', message: reason }, 409);
    }

    const paidAt = optDateString(body.paidAt, '实际付款日期') ?? todayInTz();
    const amount = optString(body.amount, '实际金额', 32) ?? bill.amount;
    const currency = (optString(body.currency, '币种', 3) ?? bill.currency).toUpperCase();
    if (Number(amount) < 0) return c.json({ error: 'invalid_request', message: '金额不能为负' }, 400);

    const result = await db.transaction(async (tx) => {
      const [payment] = await tx
        .insert(payments)
        .values({
          subscriptionId: bill.subscriptionId,
          expectedBillId: bill.id,
          paidAt,
          amount,
          currency,
          isRefund: false,
          paymentChannel: optString(body.paymentChannel, '支付渠道', 64),
          note: optString(body.note, '备注', 2000),
        })
        .returning();

      const [updatedBill] = await tx
        .update(expectedBills)
        .set({ status: 'confirmed', updatedAt: new Date() })
        .where(eq(expectedBills.id, id))
        .returning();

      return { payment, bill: updatedBill };
    });

    // 确认付款后顺延下次扣费日（仅当它正是这次账单的日期）
    const [sub] = await db.select(SUB_FIELDS).from(subscriptions).where(eq(subscriptions.id, bill.subscriptionId)).limit(1);
    if (sub && sub.nextBillingDate === bill.plannedDate) {
      const config = toConfig(sub as unknown as Record<string, unknown>);
      const next = generateExpectedBills({ ...config, anchorDate: bill.plannedDate, nextBillingDate: bill.plannedDate }, {
        from: bill.plannedDate,
        horizonMonths: 24,
      });
      const following = next.find((b) => b.plannedDate > bill.plannedDate);
      if (following) {
        await db
          .update(subscriptions)
          .set({ nextBillingDate: following.plannedDate, updatedAt: new Date() })
          .where(eq(subscriptions.id, bill.subscriptionId));
      }
    }

    return c.json(result, 201);
  }),
);

subscriptionRoutes.post('/bills/:id/skip', requireAuth, async (c) =>
  guard(c, async () => {
    const id = parseUuid(c.req.param('id'), '账单 ID');
    const [updated] = await db
      .update(expectedBills)
      .set({ status: 'skipped', updatedAt: new Date() })
      .where(and(eq(expectedBills.id, id), eq(expectedBills.status, 'expected')))
      .returning();
    if (!updated) return c.json({ error: 'invalid_state', message: '只有预计状态的账单可以跳过' }, 409);
    return c.json({ bill: updated });
  }),
);

/* ────────────────────────── 实际付款 ────────────────────────── */

subscriptionRoutes.get('/payments/list', requireAuth, async (c) =>
  guard(c, async () => {
    const from = c.req.query('from');
    const to = c.req.query('to');
    const conditions = [];
    if (from) conditions.push(gte(payments.paidAt, from));
    if (to) conditions.push(lte(payments.paidAt, to));

    const rows = await db
      .select({
        id: payments.id,
        subscriptionId: payments.subscriptionId,
        subscriptionName: subscriptions.name,
        paidAt: payments.paidAt,
        amount: payments.amount,
        currency: payments.currency,
        isRefund: payments.isRefund,
        fxRate: payments.fxRate,
        fxRateSource: payments.fxRateSource,
        cnyAmount: payments.cnyAmount,
        isEstimatedFx: payments.isEstimatedFx,
        paymentChannel: payments.paymentChannel,
        note: payments.note,
      })
      .from(payments)
      .leftJoin(subscriptions, eq(subscriptions.id, payments.subscriptionId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(payments.paidAt))
      .limit(300);

    return c.json({ payments: rows });
  }),
);

/**
 * 手动记账：不要求先有预计账单（PRD FR-06）。
 * 退款用 isRefund 标记，统计时扣减净支出。
 */
subscriptionRoutes.post('/payments', requireAuth, async (c) =>
  guard(c, async () => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: 'invalid_request', message: '请求体必须是 JSON' }, 400);

    const paidAt = optDateString(body.paidAt, '付款日期') ?? todayInTz();
    const amount = reqString(body.amount, '金额', 32);
    if (!Number.isFinite(Number(amount)) || Number(amount) < 0) {
      return c.json({ error: 'invalid_request', message: '金额必须是非负数字' }, 400);
    }

    const currency = assertCurrency(optString(body.currency, '币种', 3) ?? 'CNY');

    let subscriptionId: string | null = null;
    if (body.subscriptionId) {
      subscriptionId = parseUuid(String(body.subscriptionId), '订阅 ID');
      const [sub] = await db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.id, subscriptionId)).limit(1);
      if (!sub) return c.json({ error: 'invalid_request', message: '指定的订阅不存在' }, 400);
    }

    // 人民币折算：优先用手动汇率（标记为「估算」），否则尝试配置的汇率源；
    // 都拿不到就如实留空，绝不编造汇率（PRD FR-06）。
    const fx = await resolveCnyAmount({
      amount,
      currency,
      paidAt,
      manualRate: optString(body.fxRate, '汇率', 32),
      manualSource: optString(body.fxRateSource, '汇率来源', 64),
    });

    const [created] = await db
      .insert(payments)
      .values({
        subscriptionId,
        expectedBillId: null,
        paidAt,
        amount,
        currency,
        isRefund: optBoolean(body.isRefund, '退款标记', false),
        fxRate: fx.fxRate,
        fxRateSource: fx.fxRateSource,
        fxRateDate: fx.fxRate || fx.cnyAmount ? paidAt : null,
        cnyAmount: fx.cnyAmount,
        isEstimatedFx: fx.isEstimatedFx,
        paymentChannel: optString(body.paymentChannel, '支付渠道', 64),
        note: optString(body.note, '备注', 2000),
      })
      .returning();

    return c.json({ payment: created }, 201);
  }),
);

/** 退款登记：作为独立记录，不与支出混为一谈 */
subscriptionRoutes.post('/payments/:id/refund', requireAuth, async (c) =>
  guard(c, async () => {
    const id = parseUuid(c.req.param('id'), '付款 ID');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const [original] = await db.select().from(payments).where(eq(payments.id, id)).limit(1);
    if (!original) return c.json({ error: 'not_found', message: '付款记录不存在' }, 404);
    if (original.isRefund) return c.json({ error: 'invalid_state', message: '退款记录不能再退款' }, 409);

    const amount = optString(body.amount, '退款金额', 32) ?? original.amount;
    if (Number(amount) <= 0) return c.json({ error: 'invalid_request', message: '退款金额必须大于 0' }, 400);
    if (Number(amount) > Number(original.amount)) {
      return c.json({ error: 'invalid_request', message: '退款金额不能超过原付款金额' }, 400);
    }

    const [refund] = await db
      .insert(payments)
      .values({
        subscriptionId: original.subscriptionId,
        expectedBillId: null,
        paidAt: optDateString(body.paidAt, '退款日期') ?? todayInTz(),
        amount,
        currency: original.currency,
        isRefund: true,
        paymentChannel: original.paymentChannel,
        note: optString(body.note, '备注', 2000) ?? `退款自 ${original.id}`,
      })
      .returning();

    return c.json({ refund }, 201);
  }),
);

/** 统计：两套口径分开返回，绝不混算（PRD FR-06） */
subscriptionRoutes.get('/analytics/summary', requireAuth, async (c) =>
  guard(c, async () => {
    const from = c.req.query('from') ?? '1970-01-01';
    const to = c.req.query('to') ?? todayInTz();

    const actual = await db
      .select({
        currency: payments.currency,
        gross: sql<string>`coalesce(sum(case when ${payments.isRefund} then 0 else ${payments.amount} end), 0)::text`,
        refunds: sql<string>`coalesce(sum(case when ${payments.isRefund} then ${payments.amount} else 0 end), 0)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(payments)
      .where(and(gte(payments.paidAt, from), lte(payments.paidAt, to)))
      .groupBy(payments.currency);

    const byMonth = await db
      .select({
        month: sql<string>`to_char(${payments.paidAt}, 'YYYY-MM')`,
        currency: payments.currency,
        net: sql<string>`coalesce(sum(case when ${payments.isRefund} then -${payments.amount} else ${payments.amount} end), 0)::text`,
      })
      .from(payments)
      .where(and(gte(payments.paidAt, from), lte(payments.paidAt, to)))
      .groupBy(sql`to_char(${payments.paidAt}, 'YYYY-MM')`, payments.currency)
      .orderBy(sql`to_char(${payments.paidAt}, 'YYYY-MM')`);

    const pendingBills = await db
      .select({
        currency: expectedBills.currency,
        expected: sql<string>`coalesce(sum(${expectedBills.amount}), 0)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(expectedBills)
      .where(and(eq(expectedBills.status, 'expected'), isNotNull(expectedBills.plannedDate)))
      .groupBy(expectedBills.currency);

    return c.json({
      range: { from, to },
      // 口径 A：预计（尚未发生）
      expected: pendingBills.map((r) => ({ currency: r.currency, amount: r.expected, count: r.count })),
      // 口径 B：实付净支出（已确认付款扣除退款）
      actualNet: actual.map((r) => ({
        currency: r.currency,
        gross: r.gross,
        refunds: r.refunds,
        net: (Number(r.gross) - Number(r.refunds)).toFixed(2),
        count: r.count,
      })),
      byMonth,
      disclaimer: '预计与实付为两套口径，不可相加；跨币种汇总需带日期的汇率快照',
    });
  }),
);

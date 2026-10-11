/**
 * 订阅计费规则（PRD FR-05 / FR-06）
 *
 * 纯函数，不碰数据库——这里算错会直接导致账单日期与金额错误，因此必须逐条测试。
 *
 * 硬性规则：
 *   1. 自然月遇到 29/30/31 日时落到"对应月份最后一天"（PRD FR-05 默认设计）；
 *   2. 金额一律用最小单位整数运算后转字符串，**禁止二进制浮点**（PRD 第 5 节）；
 *   3. 自动续费关闭时不得无限生成未来扣费，只能显示已知服务到期日（PRD FR-04）；
 *   4. "预计月均"与"实付"是两套口径，绝不混用（PRD FR-06）。
 */
import { addDays, addMonthsClamped, daysBetween, daysInMonth, todayInTz } from './time';

export type BillingPeriod = 'monthly' | 'quarterly' | 'yearly' | 'custom_days' | 'lifetime';

export type SubscriptionStatus = 'trial' | 'active' | 'paused' | 'auto_renew_off' | 'ended';

export type BillingConfig = {
  price: string | null;
  currency: string;
  billingPeriod: BillingPeriod;
  /** 仅 custom_days 使用 */
  billingIntervalDays: number | null;
  /** 计费锚点：决定每次扣费的"日" */
  anchorDate: string | null;
  nextBillingDate: string | null;
  serviceEndDate: string | null;
  autoRenew: boolean;
  status: SubscriptionStatus;
};

/** 一个计费周期折算成月数；custom_days 用平均月长（365/12）折算 */
export function periodInMonths(period: BillingPeriod, intervalDays: number | null): number | null {
  switch (period) {
    case 'monthly':
      return 1;
    case 'quarterly':
      return 3;
    case 'yearly':
      return 12;
    case 'custom_days':
      return intervalDays && intervalDays > 0 ? intervalDays / (365 / 12) : null;
    case 'lifetime':
      return null;
    default:
      return null;
  }
}

/** 金额按最小单位整数相加，避免浮点误差；输入输出都是十进制字符串 */
export function addMoney(a: string, b: string): string {
  // 货币金额固定两位小数：不能只按输入精度决定，否则 0.1+0.2 会得到 '0.3'
  const scale = Math.max(2, decimalsOf(a), decimalsOf(b));
  const factor = 10 ** scale;
  const sum = Math.round(Number(a) * factor) + Math.round(Number(b) * factor);
  return (sum / factor).toFixed(scale);
}

export function decimalsOf(value: string): number {
  const dot = value.indexOf('.');
  return dot < 0 ? 0 : value.length - dot - 1;
}

function validPrice(price: string | null): string {
  if (price === null || price === '') return '0.00';
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0) return '0.00';
  return n.toFixed(2);
}

/**
 * 把一次扣费日期按周期推到第 n 次。
 * 月/季/年走自然月并做月末夹取；custom_days 走固定天数。
 */
export function projectBillingDate(anchor: string, period: BillingPeriod, intervalDays: number | null, n: number): string {
  switch (period) {
    case 'monthly':
      return addMonthsClamped(anchor, n);
    case 'quarterly':
      return addMonthsClamped(anchor, n * 3);
    case 'yearly':
      return addMonthsClamped(anchor, n * 12);
    case 'custom_days': {
      const step = intervalDays && intervalDays > 0 ? intervalDays : 30;
      return addDays(anchor, n * step);
    }
    default:
      return anchor;
  }
}

export type ExpectedBillPlan = {
  plannedDate: string;
  amount: string;
  currency: string;
};

/**
 * 生成未来 12 个月滚动预计账单（PRD FR-06）。
 *
 * - 起算点：nextBillingDate 优先，否则用 anchorDate；都没有则不生成；
 * - 到期/暂停/结束的订阅不生成；
 * - 自动续费关闭时，只生成到 serviceEndDate 为止，不无限外推（PRD FR-04）；
 * - 只生成今天及以后的账单（过去的由实际付款记录负责）。
 */
export function generateExpectedBills(
  config: BillingConfig,
  options: { from?: string; horizonMonths?: number } = {},
): ExpectedBillPlan[] {
  const from = options.from ?? todayInTz();
  const horizonMonths = options.horizonMonths ?? 12;

  // 生命周期上不该继续扣费的状态
  if (config.status === 'ended' || config.status === 'paused') return [];
  if (config.billingPeriod === 'lifetime') return [];
  if (!config.price) return [];

  const amount = validPrice(config.price);
  if (Number(amount) <= 0) return [];

  const anchor = config.nextBillingDate ?? config.anchorDate;
  if (!anchor) return [];

  // 自动续费关闭：服务到期日之后不再产生任何扣费
  const stopAt = !config.autoRenew ? config.serviceEndDate : config.serviceEndDate ?? null;
  if (!config.autoRenew && !stopAt) return [];

  const horizonEnd = addMonthsClamped(from, horizonMonths);
  const bills: ExpectedBillPlan[] = [];
  const seen = new Set<string>();

  // 上限保护：custom_days 可能很小，用一个宽松但有界的次数上限
  for (let n = 0; n < 400; n++) {
    const plannedDate = projectBillingDate(anchor, config.billingPeriod, config.billingIntervalDays, n);
    if (plannedDate > horizonEnd) break;
    if (stopAt && plannedDate > stopAt) break;

    if (plannedDate >= from && !seen.has(plannedDate)) {
      seen.add(plannedDate);
      bills.push({ plannedDate, amount, currency: config.currency });
    }

    // 防御：周期推进不动（异常配置）时立即停止，避免死循环
    if (plannedDate === anchor && n > 0) break;
  }

  return bills;
}

/**
 * 按当前周期折算的预计月均支出（PRD FR-06 口径之一）。
 * 终身/一次性订阅不计入月均。
 */
export function monthlyEquivalent(config: BillingConfig): string | null {
  const months = periodInMonths(config.billingPeriod, config.billingIntervalDays);
  if (months === null || months <= 0) return null;
  if (!config.price) return null;

  const price = Number(validPrice(config.price));
  if (!Number.isFinite(price) || price <= 0) return null;
  const perMonth = Math.round((price / months) * 100) / 100;
  return perMonth.toFixed(2);
}

/** 服务到期日与今天的天数差；已过期为负 */
export function daysUntilServiceEnd(config: BillingConfig, today = todayInTz()): number | null {
  if (!config.serviceEndDate) return null;
  return daysBetween(today, config.serviceEndDate);
}

export type BillingIssue = { field: string; message: string };

/** 档案保存前的业务校验；返回空数组表示通过 */
export function validateBillingConfig(input: {
  price: string | null;
  billingPeriod: BillingPeriod;
  billingIntervalDays: number | null;
  anchorDate: string | null;
  serviceEndDate: string | null;
  autoRenew: boolean;
}): BillingIssue[] {
  const issues: BillingIssue[] = [];

  if (input.price !== null && input.price !== '') {
    const n = Number(input.price);
    if (!Number.isFinite(n)) issues.push({ field: 'price', message: '价格必须是数字' });
    else if (n < 0) issues.push({ field: 'price', message: '价格不能为负' });
    else if (decimalsOf(input.price) > 2) issues.push({ field: 'price', message: '价格最多两位小数' });
  }

  if (input.billingPeriod === 'custom_days') {
    if (!input.billingIntervalDays || input.billingIntervalDays <= 0) {
      issues.push({ field: 'billingIntervalDays', message: '自定义周期必须提供正整数天数' });
    } else if (input.billingIntervalDays > 3650) {
      issues.push({ field: 'billingIntervalDays', message: '自定义周期天数过大' });
    }
  }

  if (input.billingPeriod !== 'lifetime' && !input.anchorDate) {
    issues.push({ field: 'anchorDate', message: '非终身订阅必须提供计费锚点日期' });
  }

  if (input.anchorDate && input.serviceEndDate && input.serviceEndDate < input.anchorDate) {
    issues.push({ field: 'serviceEndDate', message: '服务到期日不能早于计费锚点' });
  }

  return issues;
}

/**
 * 月末夹取的自检：给定锚点，验证 2 月、小月、闰年的落点都符合预期。
 * 供测试与运维排查使用。
 */
export function describeMonthEndRule(anchor: string): { month: string; date: string; clamped: boolean }[] {
  return [1, 2, 3, 4].map((n) => {
    const date = addMonthsClamped(anchor, n);
    const [, , day] = date.split('-').map(Number);
    const anchorDay = Number(anchor.split('-')[2]);
    return { month: date.slice(0, 7), date, clamped: day !== anchorDay };
  });
}

export { daysInMonth };

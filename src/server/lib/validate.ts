/**
 * 请求体校验：不引入额外依赖，手写小而严格的校验器。
 * 任何非法输入都必须以明确的中文错误返回 400，而不是让数据库抛错。
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * 支持的币种白名单。
 *
 * 只校验"3 位大写字母"会放过 RMB、US 这类常见错写，而错误币种会让金额分组与
 * 人民币汇总**静默失真**。手动录入、CSV 导入必须共用同一份白名单，
 * 否则会出现"API 拒绝、CSV 放行"的不一致，脏数据照样进账本。
 */
export const SUPPORTED_CURRENCIES = new Set([
  'CNY', 'USD', 'EUR', 'JPY', 'GBP', 'HKD', 'TWD', 'SGD', 'AUD', 'CAD',
  'KRW', 'INR', 'RUB', 'CHF', 'NZD', 'THB', 'MYR', 'VND', 'PHP', 'IDR',
]);

export function isSupportedCurrency(value: string): boolean {
  const currency = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) && SUPPORTED_CURRENCIES.has(currency);
}

export function assertCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!isSupportedCurrency(currency)) {
    throw new ValidationError(
      `不支持的币种「${value}」，请使用标准代码（如 CNY、USD、JPY）；注意人民币是 CNY 而不是 RMB`,
    );
  }
  return currency;
}

export function reqString(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string') throw new ValidationError(`${field}必须是字符串`);
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError(`${field}不能为空`);
  if (trimmed.length > max) throw new ValidationError(`${field}长度不能超过 ${max} 个字符`);
  return trimmed;
}

export function optString(value: unknown, field: string, max = 2000): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError(`${field}必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ValidationError(`${field}长度不能超过 ${max} 个字符`);
  return trimmed || null;
}

export function optBoolean(value: unknown, field: string, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new ValidationError(`${field}必须是布尔值`);
  return value;
}

/** 绝对时刻：接受 ISO 字符串 */
export function reqInstant(value: unknown, field: string): Date {
  if (typeof value !== 'string') throw new ValidationError(`${field}必须是时间字符串`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${field}不是合法时间`);
  return date;
}

export function optInstant(value: unknown, field: string): Date | null {
  if (value === undefined || value === null || value === '') return null;
  return reqInstant(value, field);
}

/** 日历日期：YYYY-MM-DD，只做格式与真实性校验，不做时区换算 */
export function optDateString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError(`${field}必须是 YYYY-MM-DD 格式`);
  }
  const [y, m, d] = value.split('-').map(Number);
  if (m! < 1 || m! > 12 || d! < 1 || d! > 31) throw new ValidationError(`${field}不是合法日期`);
  // 用 UTC 反查，禁止 2026-02-30 这类"看起来合法"的日期
  const probe = new Date(Date.UTC(y!, m! - 1, d!));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m! - 1 || probe.getUTCDate() !== d!) {
    throw new ValidationError(`${field}不是合法日期`);
  }
  return value;
}

/** 时刻：HH:mm */
export function optTimeString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) {
    throw new ValidationError(`${field}必须是 HH:mm 格式`);
  }
  const [h, m] = value.split(':').map(Number);
  if (h! > 23 || m! > 59) throw new ValidationError(`${field}不是合法时刻`);
  return value;
}

/** 提醒提前量：正整数分钟，去重排序，限制数量与上限 */
export function optOffsets(value: unknown, field: string): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${field}必须是数组`);
  if (value.length > 10) throw new ValidationError(`${field}最多 10 项`);

  const out = value.map((v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new ValidationError(`${field}只能包含数字`);
    const n = Math.floor(v);
    if (n <= 0) throw new ValidationError(`${field}必须为正整数分钟`);
    if (n > 60 * 24 * 30) throw new ValidationError(`${field}单项不能超过 30 天`);
    return n;
  });

  return [...new Set(out)].sort((a, b) => b - a);
}

/** 查询参数中的时间范围 */
export function optQueryInstant(value: string | undefined, field: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${field}不是合法时间`);
  return date;
}

export function optQueryDate(value: string | undefined, field: string): string | null {
  if (!value) return null;
  return optDateString(value, field);
}

export function parseUuid(value: string, field = 'ID'): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ValidationError(`${field}格式不正确`);
  }
  return value;
}

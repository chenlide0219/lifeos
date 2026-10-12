/**
 * 汇率快照获取（PRD FR-06）
 *
 * 设计原则：
 *   - **数据源由使用者决定**（PRD §11.5 把"实际汇率数据源"列为部署阶段填写的配置项），
 *     因此这里只提供一个按 URL 模板取数的通用机制，不绑定任何具体服务；
 *   - 汇率必须**带日期与来源**才能用于人民币汇总，否则不得冒充精确金额；
 *   - 取不到就返回 null，由调用方回退为手动汇率并标记 `isEstimatedFx`，
 *     **绝不猜测、绝不用过期汇率冒充当日汇率**。
 *
 * 配置（写入 /opt/lifeos/.env）：
 *   FX_PROVIDER_URL=https://example.com/rate?from={from}&to={to}&date={date}
 *   FX_PROVIDER_NAME=example
 *   FX_JSON_PATH=data.rate        # 可选，从响应 JSON 中取值的点路径
 *   FX_TIMEOUT_MS=8000            # 可选
 */

export type FxRate = {
  rate: string;
  source: string;
  /** 汇率对应的日期（YYYY-MM-DD） */
  date: string;
};

export function isFxConfigured(): boolean {
  return Boolean(process.env.FX_PROVIDER_URL);
}

export function fxProviderName(): string {
  return process.env.FX_PROVIDER_NAME ?? 'configured-provider';
}

/** 汇率精度：8 位小数足以覆盖常见货币对，避免过多无意义精度 */
function normalizeRate(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value > 1e9) return null;
  return value.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}

/** 按点路径从响应里取值，如 data.rates.CNY */
export function pickByPath(payload: unknown, path: string | undefined): unknown {
  if (!path) return payload;
  let current: unknown = payload;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * 常见汇率字段，按优先级尝试。
 *
 * 存在的理由：未配置 FX_JSON_PATH 时，pickByPath 会把**整个响应对象**当作结果返回，
 * 而调用方只接受数值，于是取到 NaN、最终静默返回 null —— 数据源明明返回了正确结构，
 * 却永远取不到汇率。因此未配置路径时必须自动识别常见字段。
 */
const COMMON_RATE_PATHS = [
  'rate',
  'result',
  'price',
  'value',
  'close',
  'conversion_rate',
  'conversionRate',
  'exchange_rate',
  'data.rate',
  'data.price',
  'data.value',
  'data.result',
  'rates.CNY',
  'data.rates.CNY',
];

function toRateNumber(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : Number.NaN;
  }
  return Number.NaN;
}

/**
 * 从响应中取出汇率数值。
 * 配置了 FX_JSON_PATH 就严格按该路径取；否则先看响应本身是否为数值，
 * 再按常见字段名逐个尝试。
 */
export function extractRateValue(payload: unknown, path: string | undefined): number {
  if (path) return toRateNumber(pickByPath(payload, path));

  const direct = toRateNumber(payload);
  if (Number.isFinite(direct)) return direct;

  for (const candidate of COMMON_RATE_PATHS) {
    const value = toRateNumber(pickByPath(payload, candidate));
    if (Number.isFinite(value)) return value;
  }
  return Number.NaN;
}

/** 缓存：同一 from/to/date 一天内不重复请求上游 */
const cache = new Map<string, { at: number; value: FxRate | null }>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export function clearFxCache(): void {
  cache.clear();
}

export async function fetchRate(from: string, to: string, date: string): Promise<FxRate | null> {
  if (!isFxConfigured()) return null;

  const key = `${from}|${to}|${date}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const template = process.env.FX_PROVIDER_URL!;
  const url = template
    .replace(/\{from\}/g, encodeURIComponent(from))
    .replace(/\{to\}/g, encodeURIComponent(to))
    .replace(/\{date\}/g, encodeURIComponent(date));

  let result: FxRate | null = null;
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(Number(process.env.FX_TIMEOUT_MS ?? 8_000)),
    });

    if (!response.ok) {
      // 上游报错时不写缓存里的"成功"，但也缓存失败以免每个请求都打一次
      cache.set(key, { at: Date.now(), value: null });
      return null;
    }

    const payload: unknown = await response.json();
    const parsed = extractRateValue(payload, process.env.FX_JSON_PATH);
    const rate = normalizeRate(parsed);

    if (rate) {
      result = { rate, source: fxProviderName(), date };
    }
  } catch {
    // 网络/超时/解析失败一律视为"取不到"，由调用方回退到手动汇率
    result = null;
  }

  cache.set(key, { at: Date.now(), value: result });
  return result;
}

/**
 * 为付款记录补齐人民币折算。
 *
 * 返回 `isEstimatedFx` 明确区分两种来源：
 *   - 自动汇率取得 → false，并带上来源与日期；
 *   - 只有手动汇率 → true，**不得伪装为精确金额**（PRD FR-06）。
 */
export async function resolveCnyAmount(input: {
  amount: string;
  currency: string;
  paidAt: string;
  manualRate?: string | null;
  manualSource?: string | null;
}): Promise<{ fxRate: string | null; fxRateSource: string | null; cnyAmount: string | null; isEstimatedFx: boolean }> {
  const currency = input.currency.toUpperCase();
  if (currency === 'CNY') {
    return { fxRate: null, fxRateSource: null, cnyAmount: Number(input.amount).toFixed(2), isEstimatedFx: false };
  }

  // 手动汇率优先：使用者显式给了值，说明他知道自己在做什么
  if (input.manualRate) {
    const rate = Number(input.manualRate);
    if (Number.isFinite(rate) && rate > 0) {
      return {
        fxRate: input.manualRate,
        fxRateSource: input.manualSource ?? 'manual',
        cnyAmount: (Number(input.amount) * rate).toFixed(2),
        isEstimatedFx: true,
      };
    }
  }

  const fetched = await fetchRate(currency, 'CNY', input.paidAt);
  if (fetched) {
    return {
      fxRate: fetched.rate,
      fxRateSource: fetched.source,
      cnyAmount: (Number(input.amount) * Number(fetched.rate)).toFixed(2),
      isEstimatedFx: false,
    };
  }

  // 取不到就如实留空，而不是编一个汇率
  return { fxRate: null, fxRateSource: null, cnyAmount: null, isEstimatedFx: false };
}

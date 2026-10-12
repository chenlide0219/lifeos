/**
 * CSV 导入解析（PRD FR-06）
 *
 * 纯函数，不碰数据库——导入错的代价是把错误数据写进账本且难以发现。
 *
 * 三条硬性要求：
 *   1. 提交前必须有预览、列映射与类型检查；
 *   2. **相同日期与金额并不必然意味着同一笔付款**，疑似重复只提示、由人审核，
 *      绝不自动合并或自动跳过；
 *   3. 批次可追溯（文件摘要、映射、结果与错误统计）。
 */
import { isSupportedCurrency } from './validate';

export type CsvRow = { line: number; values: string[] };

/** 解析 CSV；支持引号包裹、字段内换行/逗号、双引号转义、CRLF */
export function parseCsv(text: string): { header: string[]; rows: CsvRow[]; errors: string[] } {
  const errors: string[] = [];
  const records: { line: number; values: string[] }[] = [];

  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordStartLine = 1;

  const pushField = () => {
    record.push(field);
    field = '';
  };
  const pushRecord = () => {
    pushField();
    // 完全空行忽略
    if (!(record.length === 1 && record[0]!.trim() === '')) {
      records.push({ line: recordStartLine, values: record });
    }
    record = [];
    recordStartLine = line;
  };

  // 去掉 BOM，否则第一个表头会带上不可见字符导致映射失败
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\r') {
      // 交给 \n 处理
    } else if (ch === '\n') {
      pushRecord();
      line++;
      recordStartLine = line;
    } else {
      field += ch;
    }
  }

  if (inQuotes) errors.push('文件末尾有未闭合的引号，解析结果可能不完整');
  if (field !== '' || record.length > 0) pushRecord();

  if (records.length === 0) {
    return { header: [], rows: [], errors: [...errors, '文件为空或没有可解析的行'] };
  }

  const header = records[0]!.values.map((h) => h.trim());
  return { header, rows: records.slice(1), errors };
}

/** 目标字段与常见中英文表头别名 */
const FIELD_ALIASES: Record<string, string[]> = {
  paidAt: ['paidat', 'date', 'paymentdate', '日期', '付款日期', '支付日期', '交易日期', '时间'],
  amount: ['amount', 'price', 'total', '金额', '付款金额', '支付金额', '价格', '实付', '金额(元)'],
  currency: ['currency', '币种', '货币', '币别'],
  note: ['note', 'remark', 'description', 'memo', '备注', '说明', '摘要', '商品', '描述'],
  subscriptionName: ['subscription', 'service', 'name', '服务', '订阅', '服务名称', '订阅名'],
  paymentChannel: ['channel', 'method', '渠道', '支付渠道', '支付方式'],
  isRefund: ['isrefund', 'refund', '退款', '是否退款'],
};

export type ColumnMapping = Partial<Record<keyof typeof FIELD_ALIASES, number>>;

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_\-()（）]/g, '');
}

/** 依据表头自动推断列映射；识别不到的返回 undefined 由用户手动指定 */
export function autoMapColumns(header: string[]): { mapping: ColumnMapping; unmatched: string[] } {
  const mapping: ColumnMapping = {};
  const usedColumns = new Set<number>();
  const unmatched: string[] = [];

  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const index = header.findIndex(
      (h, i) => !usedColumns.has(i) && aliases.includes(normalizeHeader(h)),
    );
    if (index >= 0) {
      mapping[field as keyof ColumnMapping] = index;
      usedColumns.add(index);
    }
  }

  header.forEach((h, i) => {
    if (!usedColumns.has(i)) unmatched.push(h);
  });

  return { mapping, unmatched };
}

export type ParsedPayment = {
  line: number;
  paidAt: string;
  amount: string;
  currency: string;
  note: string | null;
  subscriptionName: string | null;
  paymentChannel: string | null;
  isRefund: boolean;
};

export type RowIssue = { line: number; field: string; message: string; raw: string[] };

/** 宽松但严格的日期解析：接受 YYYY-MM-DD、YYYY/M/D、YYYY年M月D日 */
export function parseDateCell(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;

  const normalized = raw.replace(/年|月/g, '-').replace(/日/g, '');
  const match = normalized.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!match) return null;

  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // 用 UTC 反查，拒绝 2026-02-30 这类"看起来合法"的日期
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 金额解析：去掉货币符号与千分位，拒绝非数字 */
export function parseAmountCell(value: string): string | null {
  const cleaned = value.replace(/[¥$€£,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (!cleaned) return null;
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) > 1e12) return null;
  return Math.abs(n).toFixed(2);
}

function parseBoolCell(value: string): boolean {
  return ['true', '1', 'yes', 'y', '是', '退款'].includes(value.trim().toLowerCase());
}

/**
 * 按映射把行转成付款记录；类型错误逐行报告，不猜测、不跳过。
 * 单行出错不影响其他行，但出错的行**不会被导入**。
 */
export function normalizeRows(
  rows: CsvRow[],
  mapping: ColumnMapping,
  options: { defaultCurrency?: string } = {},
): { valid: ParsedPayment[]; issues: RowIssue[] } {
  const valid: ParsedPayment[] = [];
  const issues: RowIssue[] = [];
  const defaultCurrency = (options.defaultCurrency ?? 'CNY').toUpperCase();

  const cell = (values: string[], index: number | undefined): string =>
    index === undefined ? '' : (values[index] ?? '');

  for (const row of rows) {
    const rawDate = cell(row.values, mapping.paidAt);
    const rawAmount = cell(row.values, mapping.amount);

    if (!rawDate.trim() && !rawAmount.trim()) continue; // 空行

    const paidAt = parseDateCell(rawDate);
    if (!paidAt) {
      issues.push({
        line: row.line,
        field: 'paidAt',
        message: rawDate.trim() ? `无法识别的日期「${rawDate.trim()}」` : '缺少日期',
        raw: row.values,
      });
      continue;
    }

    const amount = parseAmountCell(rawAmount);
    if (amount === null) {
      issues.push({
        line: row.line,
        field: 'amount',
        message: rawAmount.trim() ? `无法识别的金额「${rawAmount.trim()}」` : '缺少金额',
        raw: row.values,
      });
      continue;
    }

    const rawCurrency = cell(row.values, mapping.currency).trim().toUpperCase();
    const currency = rawCurrency || defaultCurrency;
    // 与手动录入共用同一份币种白名单，避免"API 拒绝、CSV 放行"的不一致
    if (!isSupportedCurrency(currency)) {
      issues.push({
        line: row.line,
        field: 'currency',
        message: rawCurrency
          ? `不支持的币种「${rawCurrency}」（人民币是 CNY 而不是 RMB）`
          : `默认币种「${defaultCurrency}」不在支持列表内`,
        raw: row.values,
      });
      continue;
    }

    valid.push({
      line: row.line,
      paidAt,
      amount,
      currency,
      note: cell(row.values, mapping.note).trim() || null,
      subscriptionName: cell(row.values, mapping.subscriptionName).trim() || null,
      paymentChannel: cell(row.values, mapping.paymentChannel).trim() || null,
      isRefund: parseBoolCell(cell(row.values, mapping.isRefund)),
    });
  }

  return { valid, issues };
}

export type ExistingPayment = { paidAt: string; amount: string; currency: string };

export type DuplicateSuspicion = {
  line: number;
  reason: 'matches_existing' | 'duplicate_in_file';
  detail: string;
};

/** 归一化键：日期 + 币种 + 金额（金额去尾零，避免 20.0 与 20.00 被当成不同） */
function dupKey(paidAt: string, amount: string, currency: string): string {
  return `${paidAt}|${currency}|${Number(amount).toFixed(2)}`;
}

/**
 * 疑似重复检测。
 *
 * **只提示、不处理**：相同日期与金额并不必然意味着同一笔付款
 * （例如同一天买了两份同样价格的东西），因此由人审核决定，绝不自动合并或跳过。
 */
export function detectDuplicateSuspects(
  candidates: ParsedPayment[],
  existing: ExistingPayment[],
): DuplicateSuspicion[] {
  const existingKeys = new Set(existing.map((e) => dupKey(e.paidAt, e.amount, e.currency)));
  const seen = new Map<string, number>();
  const suspicions: DuplicateSuspicion[] = [];

  for (const row of candidates) {
    const key = dupKey(row.paidAt, row.amount, row.currency);

    if (existingKeys.has(key)) {
      suspicions.push({
        line: row.line,
        reason: 'matches_existing',
        detail: `与已有记录同日期同金额（${row.paidAt} ${row.amount} ${row.currency}）`,
      });
    }

    const firstLine = seen.get(key);
    if (firstLine !== undefined) {
      suspicions.push({
        line: row.line,
        reason: 'duplicate_in_file',
        detail: `与文件第 ${firstLine} 行同日期同金额，可能是同一笔`,
      });
    } else {
      seen.set(key, row.line);
    }
  }

  return suspicions;
}

/** 文件摘要，用于批次追溯 */
export function hashCsv(text: string): string {
  // 不引入依赖：FNV-1a 32 位，足够做"同一文件是否重复导入过"的比对
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * CSV 单元格转义（RFC 4180）。
 *
 * 额外做**公式注入防护**：以 = + - @ 或制表符/回车开头的值，在 Excel / WPS 中会被
 * 当作公式执行（例如 `=HYPERLINK(...)`、`=cmd|...`）。导出文件往往会被下载后直接打开，
 * 因此这里统一加前导单引号，使其只能作为文本显示。
 */
function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text = typeof value === 'string' ? value : String(value);

  // 公式注入防护：先加前导单引号，再做常规转义
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * 生成 CSV 文本。
 * `bom: true` 会在开头写入 UTF-8 BOM —— Excel 打开含中文的 CSV 时不会乱码，
 * 缺了它用户会看到一片问号。
 */
export function toCsv(
  header: string[],
  rows: unknown[][],
  options: { bom?: boolean } = {},
): string {
  const lines = [header.map(escapeCell).join(',')];
  for (const row of rows) lines.push(row.map(escapeCell).join(','));
  // 用 CRLF 结尾：Excel 与多数表格工具对此兼容性最好
  const body = `${lines.join('\r\n')}\r\n`;
  return options.bom === false ? body : `﻿${body}`;
}

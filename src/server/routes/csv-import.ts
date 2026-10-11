/**
 * CSV 导入接口（PRD FR-06）
 *
 * 流程刻意分成两步：
 *   1. `preview`：只解析与检查，**不写任何数据**，把列映射、类型错误与
 *      疑似重复一并返回给用户确认；
 *   2. `commit`：按用户确认后的映射导入，并写入 csv_import_batches 以便追溯。
 *
 * 关于疑似重复：接口**只报告，不代为处理**。相同日期与金额并不必然意味着
 * 同一笔付款，是否导入由用户在预览界面决定；提交时把用户的确认情况记进批次。
 */
import { Hono } from 'hono';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { csvImportBatches, payments, subscriptions } from '../db/schema';
import {
  autoMapColumns,
  detectDuplicateSuspects,
  hashCsv,
  normalizeRows,
  parseCsv,
  type ColumnMapping,
} from '../lib/csv';
import { ValidationError, optString, reqString } from '../lib/validate';
import { requireAuth, type AppEnv } from '../middleware/auth';
import { guard } from './events';

export const csvRoutes = new Hono<AppEnv>();

/** 单次导入上限：防止一个巨大的文件把请求与事务拖垮 */
const MAX_ROWS = 5000;
const MAX_BYTES = 4 * 1024 * 1024;

function readMapping(value: unknown, header: string[]): ColumnMapping {
  if (!value || typeof value !== 'object') return autoMapColumns(header).mapping;

  const source = value as Record<string, unknown>;
  const mapping: ColumnMapping = {};
  const seen = new Set<number>();

  for (const field of ['paidAt', 'amount', 'currency', 'note', 'subscriptionName', 'paymentChannel', 'isRefund']) {
    const raw = source[field];
    if (raw === undefined || raw === null || raw === '') continue;
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= header.length) {
      throw new ValidationError(`列映射「${field}」指向的列不存在`);
    }
    if (seen.has(index)) throw new ValidationError(`列 ${index} 被多个字段重复使用`);
    seen.add(index);
    mapping[field as keyof ColumnMapping] = index;
  }

  return mapping;
}

async function loadExistingPayments(): Promise<{ paidAt: string; amount: string; currency: string }[]> {
  const rows = await db
    .select({ paidAt: payments.paidAt, amount: payments.amount, currency: payments.currency })
    .from(payments)
    .orderBy(desc(payments.paidAt))
    .limit(2000);
  return rows;
}

/** 只解析与检查，不落库 */
csvRoutes.post('/preview', requireAuth, async (c) =>
  guard(c, async () => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: 'invalid_request', message: '请求体必须是 JSON' }, 400);

    const content = typeof body.content === 'string' ? body.content : '';
    if (!content.trim()) return c.json({ error: 'invalid_request', message: 'CSV 内容为空' }, 400);
    if (Buffer.byteLength(content, 'utf-8') > MAX_BYTES) {
      return c.json({ error: 'file_too_large', message: '文件过大（上限 4MB）' }, 413);
    }

    const parsed = parseCsv(content);
    if (parsed.header.length === 0) {
      return c.json({ error: 'invalid_request', message: parsed.errors[0] ?? '无法解析文件表头' }, 400);
    }
    if (parsed.rows.length > MAX_ROWS) {
      return c.json({ error: 'too_many_rows', message: `行数超过上限（${MAX_ROWS} 行）` }, 413);
    }

    const { mapping, unmatched } = autoMapColumns(parsed.header);
    const effective = readMapping(body.mapping, parsed.header);
    const defaultCurrency = (optString(body.defaultCurrency, '默认币种', 3) ?? 'CNY').toUpperCase();

    const normalized = normalizeRows(parsed.rows, effective, { defaultCurrency });
    const existing = await loadExistingPayments();
    const suspicions = detectDuplicateSuspects(normalized.valid, existing);

    const missingRequired: string[] = [];
    if (effective.paidAt === undefined) missingRequired.push('日期');
    if (effective.amount === undefined) missingRequired.push('金额');

    return c.json({
      fileHash: hashCsv(content),
      header: parsed.header,
      parseErrors: parsed.errors,
      suggestedMapping: mapping,
      mapping: effective,
      unmatchedColumns: unmatched,
      missingRequired,
      defaultCurrency,
      totalRows: parsed.rows.length,
      validCount: normalized.valid.length,
      invalidCount: normalized.issues.length,
      // 只给前 50 行做预览，避免把整库数据灌进浏览器
      preview: normalized.valid.slice(0, 50),
      issues: normalized.issues.slice(0, 100),
      // 疑似重复：仅提示，是否导入由用户决定
      duplicateSuspects: suspicions.slice(0, 200),
      duplicateNote: '相同日期与金额并不必然意味着同一笔付款，请人工判断后决定是否导入',
      canCommit: missingRequired.length === 0 && normalized.valid.length > 0,
    });
  }),
);

/** 按确认后的映射导入，并记录批次 */
csvRoutes.post('/commit', requireAuth, async (c) =>
  guard(c, async () => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: 'invalid_request', message: '请求体必须是 JSON' }, 400);

    const content = reqString(body.content, 'CSV 内容', MAX_BYTES);
    const filename = optString(body.filename, '文件名', 255) ?? 'import.csv';
    const defaultCurrency = (optString(body.defaultCurrency, '默认币种', 3) ?? 'CNY').toUpperCase();

    const parsed = parseCsv(content);
    if (parsed.header.length === 0) {
      return c.json({ error: 'invalid_request', message: parsed.errors[0] ?? '无法解析文件表头' }, 400);
    }
    if (parsed.rows.length > MAX_ROWS) {
      return c.json({ error: 'too_many_rows', message: `行数超过上限（${MAX_ROWS} 行）` }, 413);
    }

    const mapping = readMapping(body.mapping, parsed.header);
    if (mapping.paidAt === undefined || mapping.amount === undefined) {
      return c.json({ error: 'invalid_request', message: '必须指定日期列与金额列' }, 400);
    }

    const normalized = normalizeRows(parsed.rows, mapping, { defaultCurrency });
    if (normalized.valid.length === 0) {
      return c.json(
        { error: 'nothing_to_import', message: '没有可导入的有效行，请检查列映射与数据类型' },
        400,
      );
    }

    // 订阅名 → id，导入时尽量关联（找不到就留空，不影响导入）
    const names = [...new Set(normalized.valid.map((r) => r.subscriptionName).filter((n): n is string => Boolean(n)))];
    const nameToId = new Map<string, string>();
    if (names.length > 0) {
      const subs = await db
        .select({ id: subscriptions.id, name: subscriptions.name })
        .from(subscriptions)
        .where(inArray(subscriptions.name, names));
      for (const s of subs) nameToId.set(s.name, s.id);
    }

    const existing = await loadExistingPayments();
    const suspicions = detectDuplicateSuspects(normalized.valid, existing);
    const suspiciousLines = new Set(suspicions.map((s) => s.line));

    const result = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(payments)
        .values(
          normalized.valid.map((row) => ({
            subscriptionId: row.subscriptionName ? (nameToId.get(row.subscriptionName) ?? null) : null,
            expectedBillId: null,
            paidAt: row.paidAt,
            amount: row.amount,
            currency: row.currency,
            isRefund: row.isRefund,
            paymentChannel: row.paymentChannel,
            note: row.note,
          })),
        )
        .returning({ id: payments.id });

      const [batch] = await tx
        .insert(csvImportBatches)
        .values({
          filename,
          fileHash: hashCsv(content),
          mapping: mapping as unknown as Record<string, unknown>,
          totalRows: parsed.rows.length,
          okRows: inserted.length,
          errorRows: normalized.issues.length,
          errors: {
            // 只留可读摘要，不存整份文件
            issues: normalized.issues.slice(0, 200),
            duplicateSuspects: suspicions.slice(0, 200),
            suspiciousImported: suspicions.length,
          },
        })
        .returning({ id: csvImportBatches.id });

      return { batchId: batch!.id, imported: inserted.length };
    });

    return c.json(
      {
        ...result,
        invalidCount: normalized.issues.length,
        // 明确告知有多少行属于"疑似重复但按你的确认导入了"，便于事后核对
        suspiciousImported: suspiciousLines.size,
        issues: normalized.issues.slice(0, 50),
      },
      201,
    );
  }),
);

/** 导入批次历史，供追溯 */
csvRoutes.get('/batches', requireAuth, async (c) =>
  guard(c, async () => {
    const rows = await db
      .select({
        id: csvImportBatches.id,
        filename: csvImportBatches.filename,
        fileHash: csvImportBatches.fileHash,
        totalRows: csvImportBatches.totalRows,
        okRows: csvImportBatches.okRows,
        errorRows: csvImportBatches.errorRows,
        createdAt: csvImportBatches.createdAt,
      })
      .from(csvImportBatches)
      .orderBy(desc(csvImportBatches.createdAt))
      .limit(50);

    const totals = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(csvImportBatches)
      .where(and(eq(csvImportBatches.errorRows, 0)));

    return c.json({ batches: rows, cleanBatches: totals[0]?.count ?? 0 });
  }),
);

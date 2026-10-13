import { useDialog } from '../hooks/useDialog';
import { useState } from 'react';
import { ApiError, requestRaw } from '../api';
import { Alert, Spinner } from './ui';

/**
 * CSV 导入对话框（PRD FR-06）。
 *
 * 流程刻意分两步：先预览（含列映射、类型错误、疑似重复），确认后才导入。
 * 疑似重复**只提示不代为处理**——相同日期与金额并不必然意味着同一笔付款，
 * 是否导入由用户判断。
 */

type PreviewRow = {
  line: number;
  paidAt: string;
  amount: string;
  currency: string;
  note: string | null;
  subscriptionName: string | null;
  isRefund: boolean;
};

type Issue = { line: number; field: string; message: string; raw: string[] };
type Suspicion = { line: number; reason: string; detail: string };

type Preview = {
  fileHash: string;
  header: string[];
  parseErrors: string[];
  mapping: Record<string, number | undefined>;
  unmatchedColumns: string[];
  missingRequired: string[];
  totalRows: number;
  validCount: number;
  invalidCount: number;
  preview: PreviewRow[];
  issues: Issue[];
  duplicateSuspects: Suspicion[];
  duplicateNote: string;
  canCommit: boolean;
};

const FIELD_LABEL: Record<string, string> = {
  paidAt: '日期',
  amount: '金额',
  currency: '币种',
  note: '备注',
  subscriptionName: '订阅名',
  paymentChannel: '支付渠道',
  isRefund: '退款标记',
};

export function CsvImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const [content, setContent] = useState('');
  const [filename, setFilename] = useState('');
  const [defaultCurrency, setDefaultCurrency] = useState('CNY');
  const [mapping, setMapping] = useState<Record<string, number | undefined>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const dialogRef = useDialog(open, onClose);

  if (!open) return null;

  function reset() {
    setContent('');
    setFilename('');
    setPreview(null);
    setError(null);
    setResult(null);
    setMapping({});
  }

  async function doPreview(csvContent?: string, nextMapping?: Record<string, number | undefined>) {
    const body = csvContent ?? content;
    if (!body.trim()) {
      setError('请先选择或粘贴 CSV 内容');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await requestRaw<Preview>('/imports/preview', {
        method: 'POST',
        body: {
          content: body,
          mapping: nextMapping ?? (Object.keys(mapping).length > 0 ? mapping : undefined),
          defaultCurrency,
        },
      });
      setPreview(res);
      setMapping(res.mapping);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '预览失败');
    } finally {
      setBusy(false);
    }
  }

  async function doCommit() {
    if (!preview) return;
    // 有类型错误的行不会被导入，这里明确告知而不是静默丢弃
    const message =
      preview.invalidCount > 0
        ? `将导入 ${preview.validCount} 行，跳过 ${preview.invalidCount} 行有格式错误的记录。\n\n继续？`
        : `将导入 ${preview.validCount} 行。继续？`;
    if (!window.confirm(message)) return;

    setBusy(true);
    setError(null);
    try {
      const res = await requestRaw<{ batchId: string; imported: number; invalidCount: number; suspiciousImported: number }>(
        '/imports/commit',
        { method: 'POST', body: { content, filename: filename || 'import.csv', mapping, defaultCurrency } },
      );
      setResult(
        `已导入 ${res.imported} 行${res.invalidCount > 0 ? `，跳过 ${res.invalidCount} 行格式错误` : ''}` +
          `${res.suspiciousImported > 0 ? `；其中 ${res.suspiciousImported} 行属于疑似重复，已按你的确认导入` : ''}` +
          `。批次号 ${res.batchId.slice(0, 8)}`,
      );
      setPreview(null);
      onImported();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '导入失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4">
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-pop sm:rounded-2xl" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="导入 CSV">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">导入 CSV</h2>
          <button type="button" className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => { reset(); onClose(); }}>
            关闭
          </button>
        </div>

        {!preview ? (
          <div className="space-y-3.5">
            <div>
              <label className="label" htmlFor="csv-file">选择文件</label>
              <input
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                className="input"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const text = await file.text();
                  setContent(text);
                  setFilename(file.name);
                  void doPreview(text, {});
                }}
              />
            </div>
            <div>
              <label className="label" htmlFor="csv-text">或直接粘贴内容</label>
              <textarea
                id="csv-text"
                className="input min-h-[7rem] resize-y font-mono text-xs"
                placeholder={'日期,金额,币种,备注\n2026-01-15,20.00,USD,ChatGPT Plus'}
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="csv-currency">缺省币种（表格里没写币种时使用）</label>
              <input id="csv-currency" className="input" value={defaultCurrency} onChange={(e) => setDefaultCurrency(e.target.value.toUpperCase())} />
            </div>
            <div className="flex justify-end">
              <button type="button" className="btn-primary" disabled={busy || !content.trim()} onClick={() => void doPreview()}>
                {busy ? <Spinner /> : null}
                解析并预览
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <Alert tone="info">
              这是预览，**尚未写入任何数据**。确认无误后再点「确认导入」。
            </Alert>

            {preview.parseErrors.length > 0 ? (
              <Alert tone="warn">{preview.parseErrors.join('；')}</Alert>
            ) : null}

            <section>
              <h3 className="mb-2 text-xs font-semibold text-muted">列映射（可调整）</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {Object.keys(FIELD_LABEL).map((field) => (
                  <div key={field} className="flex items-center gap-2">
                    <span className="w-20 shrink-0 text-xs text-muted">{FIELD_LABEL[field]}</span>
                    <select
                      className="input !py-1.5 text-xs"
                      value={mapping[field] ?? ''}
                      onChange={(e) => {
                        const next = { ...mapping };
                        if (e.target.value === '') delete next[field];
                        else next[field] = Number(e.target.value);
                        setMapping(next);
                        void doPreview(content, next);
                      }}
                    >
                      <option value="">（不使用）</option>
                      {preview.header.map((h, i) => (
                        <option key={`${h}-${i}`} value={i}>{h}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              {preview.missingRequired.length > 0 ? (
                <p className="mt-2 text-xs text-red-500">必须先指定：{preview.missingRequired.join('、')}</p>
              ) : null}
              {preview.unmatchedColumns.length > 0 ? (
                <p className="mt-1 text-xs text-muted">未使用的列：{preview.unmatchedColumns.join('、')}</p>
              ) : null}
            </section>

            <section className="grid gap-2 text-sm sm:grid-cols-3">
              <div className="rounded-xl border border-line px-3 py-2">
                <p className="text-xs text-muted">总行数</p>
                <p className="font-semibold">{preview.totalRows}</p>
              </div>
              <div className="rounded-xl border border-line px-3 py-2">
                <p className="text-xs text-muted">可导入</p>
                <p className="font-semibold text-task">{preview.validCount}</p>
              </div>
              <div className="rounded-xl border border-line px-3 py-2">
                <p className="text-xs text-muted">格式错误</p>
                <p className="font-semibold text-red-500">{preview.invalidCount}</p>
              </div>
            </section>

            {preview.duplicateSuspects.length > 0 ? (
              <Alert tone="warn">
                <p className="font-medium">疑似重复 {preview.duplicateSuspects.length} 处</p>
                <p className="mt-1">{preview.duplicateNote}</p>
                <ul className="mt-1.5 max-h-28 space-y-0.5 overflow-y-auto text-xs">
                  {preview.duplicateSuspects.slice(0, 20).map((s, i) => (
                    <li key={`${s.line}-${i}`}>第 {s.line} 行：{s.detail}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}

            {preview.issues.length > 0 ? (
              <section>
                <h3 className="mb-1.5 text-xs font-semibold text-muted">格式错误（这些行不会被导入）</h3>
                <ul className="max-h-32 space-y-0.5 overflow-y-auto text-xs text-muted">
                  {preview.issues.slice(0, 30).map((i, idx) => (
                    <li key={`${i.line}-${idx}`}>第 {i.line} 行 · {FIELD_LABEL[i.field] ?? i.field}：{i.message}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section>
              <h3 className="mb-1.5 text-xs font-semibold text-muted">数据预览（前 {preview.preview.length} 行）</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted">
                      <th className="text-left font-medium">行</th>
                      <th className="text-left font-medium">日期</th>
                      <th className="text-right font-medium">金额</th>
                      <th className="text-left font-medium">币种</th>
                      <th className="text-left font-medium">订阅</th>
                      <th className="text-left font-medium">备注</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.preview.map((r) => (
                      <tr key={r.line} className="border-t border-line">
                        <td className="py-1">{r.line}</td>
                        <td className="py-1">{r.paidAt}</td>
                        <td className="py-1 text-right">{r.isRefund ? '−' : ''}{r.amount}</td>
                        <td className="py-1">{r.currency}</td>
                        <td className="py-1">{r.subscriptionName ?? '—'}</td>
                        <td className="py-1 max-w-[12rem] truncate text-muted">{r.note ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {error ? <Alert>{error}</Alert> : null}

            <div className="flex justify-between gap-2 pt-1">
              <button type="button" className="btn-ghost" onClick={() => setPreview(null)}>
                返回修改
              </button>
              <button type="button" className="btn-primary" disabled={busy || !preview.canCommit} onClick={() => void doCommit()}>
                {busy ? <Spinner /> : null}
                确认导入
              </button>
            </div>
          </div>
        )}

        {error && !preview ? <div className="mt-3"><Alert>{error}</Alert></div> : null}
        {result ? <div className="mt-3"><Alert tone="info">{result}</Alert></div> : null}
      </div>
    </div>
  );
}

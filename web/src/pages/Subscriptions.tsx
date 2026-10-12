import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  api,
  type ExpectedBillDto,
  type PaymentDto,
  type SubscriptionDetail,
  type SubscriptionDto,
  type SubscriptionsSummary,
} from '../api';
import { IconPlus, IconSubscription } from '../components/Icons';
import { CsvImportDialog } from '../components/CsvImport';
import { Alert, Card, EmptyState, PageHeader, Spinner } from '../components/ui';

const PERIOD_LABEL: Record<string, string> = {
  monthly: '每月',
  quarterly: '每季',
  yearly: '每年',
  custom_days: '自定义天数',
  lifetime: '一次性 / 终身',
};

const STATUS_LABEL: Record<string, string> = {
  trial: '试用',
  active: '有效',
  paused: '暂停',
  auto_renew_off: '已取消自动续费',
  ended: '已结束',
};

const BILL_STATUS_LABEL: Record<string, string> = {
  expected: '预计',
  confirmed: '已确认付款',
  skipped: '已跳过',
  cancelled: '已取消',
};

const today = () => new Date().toISOString().slice(0, 10);

function money(amount: string | null, currency: string): string {
  if (amount === null) return '—';
  return `${amount} ${currency}`;
}

export function SubscriptionsPage() {
  const [list, setList] = useState<SubscriptionDto[]>([]);
  const [summary, setSummary] = useState<SubscriptionsSummary | null>(null);
  const [detail, setDetail] = useState<SubscriptionDetail | null>(null);
  const [bills, setBills] = useState<ExpectedBillDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Partial<SubscriptionDto> | null>(null);
  const [busy, setBusy] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [listRes, summaryRes, billsRes] = await Promise.all([
        api.subscriptions.list(),
        api.subscriptions.summary(),
        api.subscriptions.bills('expected'),
      ]);
      setList(listRes.subscriptions);
      setSummary(summaryRes);
      setBills(billsRes.bills);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '读取订阅失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDetail(id: string) {
    setError(null);
    try {
      setDetail(await api.subscriptions.detail(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '读取详情失败');
    }
  }

  async function saveSubscription() {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: editing.name ?? '',
        price: editing.price ?? null,
        currency: editing.currency ?? 'CNY',
        billingPeriod: editing.billingPeriod ?? 'monthly',
        billingIntervalDays: editing.billingIntervalDays ?? null,
        anchorDate: editing.anchorDate ?? null,
        nextBillingDate: editing.nextBillingDate ?? null,
        serviceEndDate: editing.serviceEndDate ?? null,
        autoRenew: editing.autoRenew ?? true,
        status: editing.status ?? 'active',
        paymentChannel: editing.paymentChannel ?? null,
        category: editing.category ?? null,
        note: editing.note ?? null,
        reminderEnabled: editing.reminderEnabled ?? false,
        reminderDaysBefore: editing.reminderDaysBefore ?? 3,
        reminderTime: (editing.reminderTime ?? '09:00').slice(0, 5),
      };
      if (editing.id) await api.subscriptions.update(editing.id, payload);
      else await api.subscriptions.create(payload);
      setNotice('已保存。预计账单已按当前计费规则重新生成。');
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  /** 确认付款：这是「预计」变成「实付」的唯一入口，必须由用户显式触发 */
  async function confirmBill(bill: ExpectedBillDto) {
    const confirmed = window.confirm(
      `确认「${bill.subscriptionName ?? ''}」${bill.plannedDate} 这笔 ${money(bill.amount, bill.currency)} 已实际支付？\n\n这会生成一条独立的实际付款记录。`,
    );
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await api.subscriptions.confirmBill(bill.id, {
        paidAt: bill.plannedDate,
        amount: bill.amount,
        currency: bill.currency,
      });
      setNotice('已记为一笔实际付款。');
      await load();
      if (detail) await openDetail(detail.subscription.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '确认失败');
    } finally {
      setBusy(false);
    }
  }

  async function skipBill(bill: ExpectedBillDto) {
    setBusy(true);
    setError(null);
    try {
      await api.subscriptions.skipBill(bill.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  async function addPayment(form: { amount: string; currency: string; paidAt: string; note: string; subscriptionId: string }) {
    setBusy(true);
    setError(null);
    try {
      await api.subscriptions.createPayment({
        amount: form.amount,
        currency: form.currency,
        paidAt: form.paidAt,
        note: form.note || null,
        subscriptionId: form.subscriptionId || null,
      });
      setNotice('已记录一笔实际付款。');
      await load();
      if (detail) await openDetail(detail.subscription.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '记账失败');
    } finally {
      setBusy(false);
    }
  }

  async function refund(payment: PaymentDto) {
    const input = window.prompt(`对这笔 ${money(payment.amount, payment.currency)} 退款多少？`, payment.amount);
    if (!input) return;
    setBusy(true);
    setError(null);
    try {
      await api.subscriptions.refund(payment.id, { amount: input, note: '界面登记退款' });
      setNotice('已登记退款，统计时将从净支出中扣减。');
      await load();
      if (detail) await openDetail(detail.subscription.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '退款登记失败');
    } finally {
      setBusy(false);
    }
  }

  async function remove(sub: SubscriptionDto) {
    if (!window.confirm(`删除订阅「${sub.name}」？\n\n已发生的实际付款记录会保留，不会因此消失。`)) return;
    setBusy(true);
    try {
      await api.subscriptions.remove(sub.id);
      setDetail(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="订阅"
        description="档案、计费周期与到期日期；预计账单与实付严格分开"
        action={
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={() => setCsvOpen(true)}>
              导入 CSV
            </button>
            <button type="button" className="btn-primary" onClick={() => setEditing({ currency: 'CNY', billingPeriod: 'monthly', autoRenew: true, status: 'active', anchorDate: today() })}>
              <IconPlus width={18} height={18} />
              新增订阅
            </button>
          </div>
        }
      />

      <CsvImportDialog open={csvOpen} onClose={() => setCsvOpen(false)} onImported={() => void load()} />

      {error ? <div className="mb-4"><Alert>{error}</Alert></div> : null}
      {notice ? <div className="mb-4"><Alert tone="info">{notice}</Alert></div> : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-line bg-surface px-4 py-3.5">
          <p className="text-xs font-medium text-muted">预计月均支出（口径一）</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight">{summary?.expectedMonthly ?? '—'}</p>
          <p className="mt-1 text-xs text-muted">{summary?.expected.monthlyTotalNote ?? '按当前周期折算，与实付不混算'}</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface px-4 py-3.5">
          <p className="text-xs font-medium text-muted">实际净支出（口径二）</p>
          {summary && summary.actual.length > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {summary.actual.map((a) => (
                <li key={a.currency} className="text-2xl font-semibold tracking-tight">
                  {a.net} <span className="text-sm font-normal text-muted">{a.currency}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-2xl font-semibold tracking-tight">—</p>
          )}
          <p className="mt-1 text-xs text-muted">仅统计已确认付款，已扣减退款</p>
        </div>
      </div>

      <Card title="待确认的预计账单" subtitle="预计账单不会自动变成支出，需要你确认">
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted"><Spinner /> 读取中…</div>
        ) : bills.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">没有待确认的预计账单</p>
        ) : (
          <ul className="divide-y divide-line">
            {bills.slice(0, 8).map((bill) => (
              <li key={bill.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{bill.subscriptionName ?? '（订阅已删除）'}</p>
                  <p className="text-xs text-muted">{bill.plannedDate} · {money(bill.amount, bill.currency)}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button type="button" className="btn-ghost !px-2.5 !py-1 text-xs" disabled={busy} onClick={() => void skipBill(bill)}>
                    跳过
                  </button>
                  <button type="button" className="btn-primary !px-2.5 !py-1 text-xs" disabled={busy} onClick={() => void confirmBill(bill)}>
                    确认已付
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="订阅列表" subtitle={`${list.length} 项`} className="mt-4">
        {list.length === 0 ? (
          <EmptyState
            icon={<IconSubscription width={28} height={28} />}
            title="还没有订阅记录"
            description="新增订阅后，系统会按计费规则生成未来 12 个月的预计账单，并出现在日历中。"
          />
        ) : (
          <ul className="divide-y divide-line">
            {list.map((sub) => (
              <li key={sub.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => void openDetail(sub.id)}>
                  <p className="truncate text-sm font-medium">{sub.name}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {STATUS_LABEL[sub.status] ?? sub.status} · {PERIOD_LABEL[sub.billingPeriod] ?? sub.billingPeriod} ·{' '}
                    {money(sub.price, sub.currency)}
                    {sub.monthlyEquivalent ? ` · 月均 ${sub.monthlyEquivalent}` : ''}
                    {sub.autoRenew ? '' : ' · 已关闭自动续费'}
                  </p>
                </button>
                <div className="flex shrink-0 gap-1">
                  <button type="button" className="rounded-lg px-2 py-1 text-xs text-muted hover:text-ink" onClick={() => setEditing(sub)}>
                    编辑
                  </button>
                  <button type="button" className="rounded-lg px-2 py-1 text-xs text-muted hover:text-red-500" onClick={() => void remove(sub)}>
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {detail ? (
        <Card
          title={`${detail.subscription.name} 的明细`}
          subtitle="预计账单 / 价格历史 / 实际付款"
          className="mt-4"
          action={
            <button type="button" className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => setDetail(null)}>
              收起
            </button>
          }
        >
          <div className="space-y-5">
            <section>
              <h3 className="mb-2 text-xs font-semibold text-muted">预计账单</h3>
              <ul className="space-y-1 text-sm">
                {detail.expectedBills.slice(0, 8).map((b) => (
                  <li key={b.id} className="flex justify-between gap-3">
                    <span>{b.plannedDate}</span>
                    <span className="text-muted">
                      {money(b.amount, b.currency)} · {BILL_STATUS_LABEL[b.status] ?? b.status}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold text-muted">价格历史（调价不追改历史付款）</h3>
              <ul className="space-y-1 text-sm">
                {detail.priceHistory.map((h) => (
                  <li key={h.id} className="flex justify-between gap-3">
                    <span>{h.effectiveFrom}</span>
                    <span className="text-muted">{money(h.price, h.currency)}</span>
                  </li>
                ))}
                {detail.priceHistory.length === 0 ? <li className="text-muted">暂无记录</li> : null}
              </ul>
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold text-muted">实际付款</h3>
              <ul className="space-y-1.5 text-sm">
                {detail.payments.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3">
                    <span>
                      {p.paidAt} {p.isRefund ? <span className="chip bg-subscription-soft text-subscription">退款</span> : null}
                    </span>
                    <span className="flex items-center gap-2 text-muted">
                      {money(p.amount, p.currency)}
                      {!p.isRefund ? (
                        <button type="button" className="text-xs underline hover:text-ink" onClick={() => void refund(p)}>
                          退款
                        </button>
                      ) : null}
                    </span>
                  </li>
                ))}
                {detail.payments.length === 0 ? <li className="text-muted">暂无付款记录</li> : null}
              </ul>
            </section>
          </div>
        </Card>
      ) : null}

      <ManualPaymentForm subscriptionId={detail?.subscription.id ?? ''} options={list} busy={busy} onSubmit={addPayment} />

      {editing ? (
        <SubscriptionDialog
          value={editing}
          busy={busy}
          onChange={setEditing}
          onCancel={() => setEditing(null)}
          onSave={saveSubscription}
        />
      ) : null}
    </>
  );
}

function SubscriptionDialog({
  value,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  value: Partial<SubscriptionDto>;
  busy: boolean;
  onChange: (v: Partial<SubscriptionDto>) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const period = value.billingPeriod ?? 'monthly';
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4">
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-pop sm:rounded-2xl" role="dialog" aria-modal="true">
        <h2 className="mb-4 text-base font-semibold">{value.id ? '编辑订阅' : '新增订阅'}</h2>
        <div className="space-y-3.5">
          <div>
            <label className="label" htmlFor="sub-name">服务名称</label>
            <input id="sub-name" className="input" value={value.name ?? ''} onChange={(e) => onChange({ ...value, name: e.target.value })} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="sub-price">当前标价</label>
              <input id="sub-price" className="input" inputMode="decimal" value={value.price ?? ''} onChange={(e) => onChange({ ...value, price: e.target.value })} placeholder="如 20.00" />
            </div>
            <div>
              <label className="label" htmlFor="sub-currency">币种</label>
              <input id="sub-currency" className="input" value={value.currency ?? 'CNY'} onChange={(e) => onChange({ ...value, currency: e.target.value.toUpperCase() })} placeholder="CNY / USD / JPY" />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="sub-period">计费周期</label>
              <select id="sub-period" className="input" value={period} onChange={(e) => onChange({ ...value, billingPeriod: e.target.value })}>
                {Object.entries(PERIOD_LABEL).map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
            </div>
            {period === 'custom_days' ? (
              <div>
                <label className="label" htmlFor="sub-days">周期天数</label>
                <input id="sub-days" className="input" inputMode="numeric" value={value.billingIntervalDays ?? ''} onChange={(e) => onChange({ ...value, billingIntervalDays: e.target.value ? Number(e.target.value) : null })} />
              </div>
            ) : (
              <div>
                <label className="label" htmlFor="sub-status">状态</label>
                <select id="sub-status" className="input" value={value.status ?? 'active'} onChange={(e) => onChange({ ...value, status: e.target.value })}>
                  {Object.entries(STATUS_LABEL).map(([k, label]) => (
                    <option key={k} value={k}>{label}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="sub-anchor">计费锚点</label>
              <input id="sub-anchor" type="date" className="input" value={value.anchorDate ?? ''} onChange={(e) => onChange({ ...value, anchorDate: e.target.value })} />
              <p className="mt-1 text-xs text-muted">遇到 29/30/31 日时自动落到当月最后一天</p>
            </div>
            <div>
              <label className="label" htmlFor="sub-next">下次预计扣费日</label>
              <input id="sub-next" type="date" className="input" value={value.nextBillingDate ?? ''} onChange={(e) => onChange({ ...value, nextBillingDate: e.target.value })} />
              <p className="mt-1 text-xs text-muted">留空则按锚点推算；可手工校正</p>
            </div>
          </div>

          <div>
            <label className="label" htmlFor="sub-end">服务到期日</label>
            <input id="sub-end" type="date" className="input" value={value.serviceEndDate ?? ''} onChange={(e) => onChange({ ...value, serviceEndDate: e.target.value })} />
          </div>

          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-line p-3.5">
            <span className="text-sm font-medium">自动续费</span>
            <input type="checkbox" className="h-4 w-4 accent-[#6366f1]" checked={value.autoRenew ?? true} onChange={(e) => onChange({ ...value, autoRenew: e.target.checked, status: e.target.checked ? 'active' : 'auto_renew_off' })} />
          </label>
          <p className="-mt-2 text-xs text-muted">关闭后系统不会再生成未来扣费，提醒也会改为「服务到期」</p>

          <div className="rounded-xl border border-line p-3.5">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span className="text-sm font-medium">微信提醒</span>
              <input
                type="checkbox"
                className="h-4 w-4 accent-[#6366f1]"
                checked={value.reminderEnabled ?? false}
                onChange={(e) => onChange({ ...value, reminderEnabled: e.target.checked })}
              />
            </label>
            {value.reminderEnabled ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="sub-remind-days">提前天数</label>
                  <input
                    id="sub-remind-days"
                    className="input"
                    inputMode="numeric"
                    value={value.reminderDaysBefore ?? 3}
                    onChange={(e) => onChange({ ...value, reminderDaysBefore: Number(e.target.value || 0) })}
                  />
                  <p className="mt-1 text-xs text-muted">0 表示当天提醒</p>
                </div>
                <div>
                  <label className="label" htmlFor="sub-remind-time">发送时刻</label>
                  <input
                    id="sub-remind-time"
                    type="time"
                    className="input"
                    value={(value.reminderTime ?? '09:00').slice(0, 5)}
                    onChange={(e) => onChange({ ...value, reminderTime: e.target.value })}
                  />
                </div>
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted">默认不提醒；开启后可分别设置提前天数与发送时刻</p>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn-ghost" onClick={onCancel}>取消</button>
            <button type="button" className="btn-primary" disabled={busy || !value.name?.trim()} onClick={onSave}>
              {busy ? <Spinner /> : null}
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ManualPaymentForm({
  subscriptionId,
  options,
  busy,
  onSubmit,
}: {
  subscriptionId: string;
  options: SubscriptionDto[];
  busy: boolean;
  onSubmit: (form: { amount: string; currency: string; paidAt: string; note: string; subscriptionId: string }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('CNY');
  const [paidAt, setPaidAt] = useState(today());
  const [note, setNote] = useState('');
  const [subId, setSubId] = useState('');

  if (!open) {
    return (
      <div className="mt-4">
        <button type="button" className="btn-ghost" onClick={() => { setOpen(true); setSubId(subscriptionId); }}>
          <IconPlus width={18} height={18} />
          手动记账
        </button>
        <p className="mt-1.5 text-xs text-muted">不要求先有预计账单</p>
      </div>
    );
  }

  return (
    <Card title="手动记账" subtitle="可直接补录，不必先有预计账单" className="mt-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className="label" htmlFor="pay-amount">金额</label>
          <input id="pay-amount" className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="pay-currency">币种</label>
          <input id="pay-currency" className="input" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </div>
        <div>
          <label className="label" htmlFor="pay-date">付款日期</label>
          <input id="pay-date" type="date" className="input" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="pay-sub">关联订阅</label>
          <select id="pay-sub" className="input" value={subId} onChange={(e) => setSubId(e.target.value)}>
            <option value="">（不关联）</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="mt-3">
        <label className="label" htmlFor="pay-note">备注</label>
        <input id="pay-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>取消</button>
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !amount.trim()}
          onClick={() => void onSubmit({ amount, currency, paidAt, note, subscriptionId: subId }).then(() => { setOpen(false); setAmount(''); setNote(''); })}
        >
          {busy ? <Spinner /> : null}
          记一笔
        </button>
      </div>
    </Card>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type AnalyticsSummary, type PaymentDto } from '../api';
import { IconAnalytics } from '../components/Icons';
import { Alert, Card, EmptyState, PageHeader, Spinner } from '../components/ui';

/**
 * 统计页。
 *
 * PRD FR-06 明确要求两套口径必须分开标注、不得相互混用：
 *   口径 A「预计」：尚未发生，按计费规则推算；
 *   口径 B「实付净支出」：已确认付款扣除退款。
 * 页面上不提供把两者相加的操作，并在底部写明汇率与口径说明。
 */
export function AnalyticsPage() {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [payments, setPayments] = useState<PaymentDto[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const range = { from: from || undefined, to: to || undefined };
      const [analytics, paymentList] = await Promise.all([
        api.subscriptions.analytics(range),
        api.subscriptions.payments(range),
      ]);
      setSummary(analytics);
      setPayments(paymentList.payments);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '读取统计失败');
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const maxMonth = Math.max(1, ...(summary?.byMonth ?? []).map((m) => Math.abs(Number(m.net))));

  return (
    <>
      <PageHeader title="统计" description="预计与实际付款分开统计，口径明确标注" />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="an-from">起始日期</label>
          <input id="an-from" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="an-to">结束日期</label>
          <input id="an-to" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <button type="button" className="btn-ghost" onClick={() => { setFrom(''); setTo(''); }}>
          清空筛选
        </button>
        {loading ? <Spinner className="mb-2.5 ml-1 text-muted" /> : null}
      </div>

      {error ? <div className="mb-4"><Alert>{error}</Alert></div> : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="预计支出" subtitle="口径 A：按活跃订阅当前计费规则推算，尚未发生">
          {!summary ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted"><Spinner /> 读取中…</div>
          ) : summary.expected.length === 0 ? (
            <EmptyState icon={<IconAnalytics width={28} height={28} />} title="暂无待确认的预计账单" description="新增订阅后，未来 12 个月的预计账单会显示在这里。" />
          ) : (
            <ul className="space-y-2">
              {summary.expected.map((e) => (
                <li key={e.currency} className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-muted">{e.count} 笔待确认</span>
                  <span className="text-lg font-semibold">
                    {e.amount} <span className="text-xs font-normal text-muted">{e.currency}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="实际净支出" subtitle="口径 B：已确认付款扣除退款">
          {!summary ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted"><Spinner /> 读取中…</div>
          ) : summary.actualNet.length === 0 ? (
            <EmptyState icon={<IconAnalytics width={28} height={28} />} title="还没有实际付款" description="在订阅页确认预计账单，或手动记账后，这里会显示净支出。" />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted">
                  <th className="text-left font-medium">币种</th>
                  <th className="text-right font-medium">付款</th>
                  <th className="text-right font-medium">退款</th>
                  <th className="text-right font-medium">净支出</th>
                </tr>
              </thead>
              <tbody>
                {summary.actualNet.map((a) => (
                  <tr key={a.currency} className="border-t border-line">
                    <td className="py-1.5">{a.currency}</td>
                    <td className="py-1.5 text-right text-muted">{a.gross}</td>
                    <td className="py-1.5 text-right text-subscription">{a.refunds}</td>
                    <td className="py-1.5 text-right font-semibold">{a.net}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title="按月趋势" subtitle="口径 B：实际净支出" className="mt-4">
        {!summary || summary.byMonth.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">暂无数据</p>
        ) : (
          <ul className="space-y-2">
            {summary.byMonth.map((m) => (
              <li key={`${m.month}-${m.currency}`} className="flex items-center gap-3">
                <span className="w-20 shrink-0 text-xs text-muted">{m.month}</span>
                <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-canvas">
                  <span
                    className={`block h-full rounded-full ${Number(m.net) < 0 ? 'bg-subscription' : 'bg-task'}`}
                    style={{ width: `${Math.min(100, (Math.abs(Number(m.net)) / maxMonth) * 100)}%` }}
                  />
                </span>
                <span className="w-28 shrink-0 text-right text-xs">
                  {m.net} <span className="text-muted">{m.currency}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="付款明细" subtitle={`${payments.length} 条`} className="mt-4">
        {payments.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">暂无付款记录</p>
        ) : (
          <ul className="divide-y divide-line">
            {payments.slice(0, 30).map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    {p.subscriptionName ?? '未关联订阅'}
                    {p.isRefund ? <span className="chip ml-2 bg-subscription-soft text-subscription">退款</span> : null}
                  </p>
                  <p className="text-xs text-muted">
                    {p.paidAt}
                    {p.note ? ` · ${p.note}` : ''}
                    {p.isEstimatedFx ? ' · 人民币金额为估算' : ''}
                  </p>
                </div>
                <span className="shrink-0 text-sm">
                  {p.isRefund ? '−' : ''}
                  {p.amount} <span className="text-xs text-muted">{p.currency}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="mt-4 rounded-2xl border border-subscription/30 bg-subscription/5 px-4 py-3.5 text-sm text-muted">
        <p className="font-medium text-subscription">口径与汇率说明</p>
        <p className="mt-1">{summary?.disclaimer ?? '预计与实付为两套口径，不可相加；跨币种汇总需带日期的汇率快照。'}</p>
        <p className="mt-1">
          人民币汇总使用带日期来源的汇率快照；汇率来源不可用时以手动汇率计算并标注「估算」，
          不伪装为精确实付人民币。
        </p>
      </div>
    </>
  );
}

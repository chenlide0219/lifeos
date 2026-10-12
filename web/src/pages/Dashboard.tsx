import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type OverviewResponse, type SubscriptionsSummary, type SystemStatusResponse } from '../api';
import { IconBell, IconCalendar, IconPlus, IconTodo } from '../components/Icons';
import { QuickAddDialog, type QuickAddMode } from '../components/QuickAdd';
import { Alert, Card, EmptyState, PageHeader, Spinner, StatusDot } from '../components/ui';
import { useAuth } from '../hooks/useAuth';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

export function DashboardPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<SystemStatusResponse | null>(null);
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [summary, setSummary] = useState<SubscriptionsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<QuickAddMode>('event');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [statusRes, overviewRes, summaryRes] = await Promise.all([
        api.status(),
        api.calendar.overview(),
        api.subscriptions.summary(),
      ]);
      setStatus(statusRes);
      setOverview(overviewRes);
      setSummary(summaryRes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '读取数据失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const now = new Date();
  const dateLabel = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${WEEKDAYS[now.getDay()]}`;

  return (
    <>
      <PageHeader
        title={`${greeting()}，${user?.username ?? ''}`}
        description={dateLabel}
        action={
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setDialogMode('task');
                setDialogOpen(true);
              }}
            >
              新增待办
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setDialogMode('event');
                setDialogOpen(true);
              }}
            >
              <IconPlus width={18} height={18} />
              新增事件
            </button>
          </div>
        }
      />

      {error ? (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="今日待办" subtitle={overview ? `今天到期或已逾期 · ${overview.tasksDueTodayCount} 项` : undefined}>
          {!overview ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted">
              <Spinner /> 读取中…
            </div>
          ) : overview.tasksDueToday.length === 0 ? (
            <EmptyState icon={<IconTodo width={28} height={28} />} title="今天没有待办" description="到期日或时刻落在今天的待办会显示在这里。" />
          ) : (
            <ul className="divide-y divide-line">
              {overview.tasksDueToday.map((task) => {
                const overdue = Boolean(task.dueDate) && task.dueDate! < overview.today;
                return (
                  <li key={task.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                    <span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>
                    <span className={`shrink-0 text-xs ${overdue ? 'font-medium text-red-500' : 'text-muted'}`}>
                      {task.dueTime ? task.dueTime.slice(0, 5) : '全天'}
                      {overdue ? ' · 逾期' : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="未来 7 天" subtitle={overview ? `${overview.events.length} 个事件` : undefined}>
          {!overview ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted">
              <Spinner /> 读取中…
            </div>
          ) : overview.events.length === 0 ? (
            <EmptyState
              icon={<IconCalendar width={28} height={28} />}
              title="暂无安排"
              description="未来一周没有事件。点「新增事件」创建一条。"
            />
          ) : (
            <ul className="divide-y divide-line">
              {overview.events.map((event) => (
                <li key={event.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{event.title}</p>
                    {event.location ? <p className="truncate text-xs text-muted">{event.location}</p> : null}
                  </div>
                  <span className="shrink-0 text-xs text-muted">
                    {event.date.slice(5)} {event.time}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="即将到期订阅"
          subtitle={summary ? `${summary.upcoming.length} 项待扣费` : '按当前计费周期推算'}
        >
          {!summary ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted">
              <Spinner /> 读取中…
            </div>
          ) : summary.upcoming.length === 0 ? (
            <EmptyState
              icon={<IconBell width={28} height={28} />}
              title="近期没有待扣费的订阅"
              description="新增订阅后，系统会按计费规则生成未来 12 个月的预计账单。"
            />
          ) : (
            <ul className="divide-y divide-line">
              {summary.upcoming.map((s) => (
                <li key={`${s.id}-${s.date}`} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{s.name}</p>
                    <p className="text-xs text-muted">
                      预计扣费 {s.date}
                      {s.autoRenew ? '' : ' · 已关闭自动续费'}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm">
                    {s.amount} <span className="text-xs text-muted">{s.currency}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="费用概览" subtitle="两套口径分开统计，不可相加">
          {!summary ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted">
              <Spinner /> 读取中…
            </div>
          ) : (
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-muted">
                  预计月均支出
                  <span className="ml-1 text-xs">（按当前周期折算）</span>
                </dt>
                <dd className="mt-1">
                  {Object.keys(summary.expected.monthlyByCurrency).length === 0 ? (
                    <span className="text-sm text-muted">暂无订阅</span>
                  ) : (
                    // 必须按币种分列：跨币种相加得到的数字没有任何意义，
                    // 而"40.00"这种不带币种的裸数字会被误读为人民币
                    <ul className="space-y-0.5">
                      {Object.entries(summary.expected.monthlyByCurrency).map(([currency, amount]) => (
                        <li key={currency} className="text-right">
                          <span className="text-lg font-semibold">{amount.toFixed(2)}</span>
                          <span className="ml-1 text-xs font-normal text-muted">{currency}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </dd>
              </div>

              <div className="border-t border-line pt-3">
                <dt className="mb-1 text-muted">
                  实际净支出
                  <span className="ml-1 text-xs">（已确认付款扣除退款）</span>
                </dt>
                {summary.actual.length === 0 ? (
                  <dd className="text-sm text-muted">尚无实际付款记录</dd>
                ) : (
                  <dd className="space-y-1">
                    {summary.actual.map((a) => (
                      <div key={a.currency} className="flex items-baseline justify-between gap-3">
                        <span className="text-xs text-muted">
                          付款 {a.gross} · 退款 {a.refunds}
                        </span>
                        <span className="text-lg font-semibold">
                          {a.net} <span className="text-xs font-normal text-muted">{a.currency}</span>
                        </span>
                      </div>
                    ))}
                  </dd>
                )}
              </div>

              <p className="border-t border-line pt-3 text-xs text-muted">
                预计与实付是两套口径，页面不提供相加；跨币种汇总需带日期的汇率快照，
                详见「统计」页。
              </p>
            </dl>
          )}
        </Card>

        <Card title="系统状态" subtitle="服务端实时数据">
          {!status ? (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Spinner /> 读取中…
            </div>
          ) : (
            <dl className="space-y-3 text-sm">
              <Row label="数据库" tone={status.db === 'up' ? 'ok' : 'error'} value={status.db === 'up' ? '正常' : '不可用'} />
              <Row label="时区" value={status.timezone} />
              <Row
                label="语音识别（MiMo）"
                tone={status.ai.asr.configured ? 'ok' : 'warn'}
                value={status.ai.asr.configured ? '已配置' : '未配置'}
              />
              <Row
                label="事项解析（DeepSeek）"
                tone={status.ai.llm.configured ? 'ok' : 'warn'}
                value={status.ai.llm.configured ? '已配置' : '未配置'}
              />
              {status.notifications.map((provider) => (
                <Row
                  key={provider.channel}
                  label={provider.name}
                  tone={provider.configured ? 'ok' : 'warn'}
                  value={provider.configured ? '已配置' : '未配置'}
                />
              ))}
            </dl>
          )}
        </Card>
      </div>

      <QuickAddDialog
        open={dialogOpen}
        mode={dialogMode}
        onClose={() => setDialogOpen(false)}
        onSaved={() => void load()}
      />
    </>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'error' | 'idle';
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="flex items-center gap-2 font-medium">
        {tone ? <StatusDot tone={tone} /> : null}
        {value}
      </dd>
    </div>
  );
}

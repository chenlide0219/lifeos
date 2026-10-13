import { Link } from 'react-router-dom';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type OverviewResponse, type SubscriptionsSummary } from '../api';
import { IconTodo, IconPlus, IconCalendar, IconSubscription } from '../components/Icons';
import { QuickAddDialog, type QuickAddMode } from '../components/QuickAdd';
import { Alert, Card, EmptyState, PageHeader, Spinner } from '../components/ui';
import { useAuth } from '../hooks/useAuth';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 日期字符串加天数（纯日历运算，配合服务端给出的上海时区"今天"使用） */
function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = new Date(Date.UTC(y!, m! - 1, d!));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

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
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [summary, setSummary] = useState<SubscriptionsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<QuickAddMode>('event');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [overviewRes, summaryRes] = await Promise.all([
        api.calendar.overview(),
        api.subscriptions.summary(),
      ]);
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

  // 「即将扣费」只在下次预计扣费落在今天起 0–7 天（含两端）时出现；
  // 日期以服务端返回的上海时区"今天"为基准，没有符合条件的项目就整卡隐藏
  const today = summary?.today;
  const upcomingBills =
    summary && today
      ? summary.upcoming.filter((s) => s.autoRenew && s.date >= today && s.date <= addDays(today, 7))
      : [];

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

      <section className="mb-7 grid grid-cols-2 overflow-hidden rounded-2xl border border-line bg-surface sm:grid-cols-3" aria-label="今日概况">
        <Link to="/todo" className="group flex items-center justify-between gap-2 border-b border-r border-line p-4 transition-colors hover:bg-canvas sm:border-b-0 sm:border-r sm:p-6">
          <div><p className="text-xs text-muted">今日待办 · 含逾期</p><p className="mt-2 text-2xl sm:text-3xl font-semibold tracking-tight">{overview?.tasksDueTodayCount ?? '—'}<span className="ml-2 text-xs font-normal text-muted">项</span></p></div>
          <IconTodo className="text-task" width={24} height={24} />
        </Link>
        <Link to="/subscriptions" className="flex items-center justify-between gap-2 border-b border-line p-4 transition-colors hover:bg-canvas sm:border-b-0 sm:border-r sm:p-6">
          <div><p className="text-xs text-muted">管理中的订阅</p><p className="mt-2 text-2xl sm:text-3xl font-semibold tracking-tight">{summary?.subscriptions ?? '—'}<span className="ml-2 text-xs font-normal text-muted">项</span></p></div>
          <IconSubscription className="text-subscription" width={24} height={24} />
        </Link>
        <Link to="/calendar" className="col-span-2 flex items-center justify-between p-4 transition-colors sm:col-span-1 hover:bg-canvas sm:p-6">
          <div><p className="text-xs text-muted">留一点时间给生活</p><p className="mt-2 text-base font-medium">查看日历 <span aria-hidden="true">↗</span></p></div>
          <IconCalendar className="text-event" width={24} height={24} />
        </Link>
      </section>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div>
        <Card title="专注今天" action={<Link to="/todo" className="inline-flex min-h-11 items-center text-xs font-medium text-brand">全部待办 ↗</Link>} subtitle={overview ? `今天到期或已逾期 · ${overview.tasksDueTodayCount} 项` : undefined}>
          {!overview ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted">
              <Spinner /> 读取中…
            </div>
          ) : overview.tasksDueToday.length === 0 ? (
            <EmptyState icon={<IconTodo width={28} height={28} />} title="今天没有待办" description="到期日落在今天或已逾期的待办会显示在这里；没有日期的待办在「待办」页。" />
          ) : (
            <ul className="record-list divide-y divide-line">
              {overview.tasksDueToday.map((task) => {
                const overdue = Boolean(task.dueDate) && task.dueDate! < overview.today;
                return (
                  <li key={task.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                    <Link to="/todo" className="min-w-0 flex-1 break-words text-sm font-medium hover:text-brand">{task.title}</Link>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-muted">
                      {task.dueTime ? task.dueTime.slice(0, 5) : '全天'}
                      {overdue ? <span className="chip bg-red-500/10 font-medium text-red-600">逾期</span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        </div>
        <div className="space-y-5">
        <Card title="快速开始" subtitle="把想法落在这里，再安心做下一件事。">
          <div className="space-y-2">
            <button type="button" className="btn-ghost w-full !justify-start" onClick={() => { setDialogMode('task'); setDialogOpen(true); }}><IconTodo className="text-task" />记一件待办<span className="ml-auto text-muted" aria-hidden="true">+</span></button>
            <button type="button" className="btn-ghost w-full !justify-start" onClick={() => { setDialogMode('event'); setDialogOpen(true); }}><IconCalendar className="text-event" />安排一段时间<span className="ml-auto text-muted" aria-hidden="true">+</span></button>
          </div>
        </Card>
        {upcomingBills.length > 0 ? (
          <Card title="即将扣费" subtitle={`未来 7 天 · ${upcomingBills.length} 项`}>
            <ul className="record-list divide-y divide-line">
              {upcomingBills.map((s) => (
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
          </Card>
        ) : null}
        </div>
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

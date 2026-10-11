import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type OverviewResponse, type SystemStatusResponse } from '../api';
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
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<QuickAddMode>('event');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [statusRes, overviewRes] = await Promise.all([api.status(), api.calendar.overview()]);
      setStatus(statusRes);
      setOverview(overviewRes);
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

        <Card title="即将到期订阅" subtitle="阶段 4 接入">
          <EmptyState
            icon={<IconBell width={28} height={28} />}
            title="订阅模块尚未实现"
            description="订阅档案、预计账单与续费提醒将在阶段 4 完成后出现在这里。"
          />
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

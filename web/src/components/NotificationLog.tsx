import { useCallback, useEffect, useState } from 'react';
import { api, type NotificationJobDto, type NotificationJobsResponse } from '../api';
import { Alert, EmptyState, Spinner } from './ui';

const FILTERS = [
  { key: '', label: '全部' },
  { key: 'missed', label: '已错过' },
  { key: 'failed', label: '失败' },
  { key: 'pending', label: '待发送' },
  { key: 'sent', label: '已发送' },
] as const;

const STATUS_LABEL: Record<string, string> = {
  pending: '待发送',
  sending: '发送中',
  sent: '已发送',
  failed: '失败',
  cancelled: '已取消',
  skipped: '已跳过',
  missed: '已错过',
};

const FAILURE_KIND_LABEL: Record<string, string> = {
  retryable: '可重试',
  rejected: '被拒绝',
  needs_human: '需人工处理',
  unknown: '结果未知',
  exhausted: '重试耗尽',
};

function statusClass(status: string, failureKind: string | null): string {
  if (status === 'sent') return 'bg-task-soft text-task';
  if (status === 'missed') return 'bg-subscription-soft text-subscription';
  if (status === 'failed') {
    // 结果未知必须与普通失败区分：它可能已送达，需要人工核实
    return failureKind === 'unknown'
      ? 'bg-red-500/15 text-red-600 dark:text-red-400 ring-1 ring-red-500/40'
      : 'bg-red-500/10 text-red-600 dark:text-red-400';
  }
  if (status === 'sending') return 'bg-event-soft text-event';
  return 'bg-canvas text-muted';
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function NotificationLog() {
  const [data, setData] = useState<NotificationJobsResponse | null>(null);
  const [filter, setFilter] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(
    async (status: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.notificationJobs({ status: status || undefined, limit: 50 });
        setData(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : '读取通知记录失败');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  const summary = data?.summary ?? {};

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {FILTERS.map(({ key, label }) => {
          const count = key ? summary[key] : data?.total;
          return (
            <button
              key={key || 'all'}
              type="button"
              onClick={() => setFilter(key)}
              aria-pressed={filter === key}
              className={`min-h-11 rounded-lg border px-3 py-1 text-xs font-medium transition-colors ${
                filter === key ? 'border-brand/30 bg-brand/10 text-brand' : 'border-line text-muted hover:text-ink'
              }`}
            >
              {label}
              {typeof count === 'number' ? ` ${count}` : ''}
            </button>
          );
        })}
        {loading ? <Spinner className="ml-1 self-center text-muted" /> : null}
      </div>

      {data && !data.providerReady ? (
        <Alert tone="warn">
          发送通道当前未配置，Worker 不会领取任何发送任务；超过错过阈值的提醒会被标记为「已错过」并记录原因，按政策不补发。
        </Alert>
      ) : null}

      {error ? <Alert>{error}</Alert> : null}

      {data && data.jobs.length === 0 ? (
        <EmptyState
          title="没有符合条件的通知记录"
          description="创建带提醒的事件或订阅后，通知任务会显示在这里。"
        />
      ) : null}

      {data && data.jobs.length > 0 ? (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
          {data.jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              expanded={expanded === job.id}
              onToggle={() => setExpanded(expanded === job.id ? null : job.id)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function JobRow({
  job,
  expanded,
  onToggle,
}: {
  job: NotificationJobDto;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="bg-surface">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-canvas"
        aria-expanded={expanded}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{job.title}</p>
          <p className="mt-0.5 text-xs text-muted">
            计划 {formatTime(job.fireAt)}
            {job.sentAt ? ` · 实际发送 ${formatTime(job.sentAt)}` : ''}
            {job.attempts > 0 ? ` · 尝试 ${job.attempts}/${job.maxAttempts}` : ''}
          </p>
        </div>
        <span className={`chip shrink-0 ${statusClass(job.status, job.failureKind)}`}>
          {STATUS_LABEL[job.status] ?? job.status}
        </span>
      </button>

      {expanded ? (
        <div className="space-y-2 border-t border-line bg-canvas/60 px-4 py-3 text-xs">
          <Row label="任务类型" value={job.subjectType === 'event' ? '事件提醒' : '订阅提醒'} />
          {job.failureKind ? (
            <Row
              label="失败类别"
              value={FAILURE_KIND_LABEL[job.failureKind] ?? job.failureKind}
            />
          ) : null}
          {job.nextAttemptAt ? <Row label="下次重试" value={formatTime(job.nextAttemptAt)} /> : null}
          {job.lastError ? (
            <div>
              <p className="text-muted">原因 / 错误</p>
              <p className="mt-1 break-words font-mono text-[11px] leading-relaxed text-ink">{job.lastError}</p>
            </div>
          ) : null}
          {job.failureKind === 'unknown' ? (
            <p className="rounded-lg bg-red-500/10 px-2.5 py-2 text-red-600 dark:text-red-400">
              无法确认下游是否已接受，按政策不自动重发，以免重复送达。请人工核实手机是否已收到。
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api, type EventDto } from '../api';
import { IconEvent, IconPlus } from '../components/Icons';
import { QuickAddDialog } from '../components/QuickAdd';
import { formatOffset } from '../components/ReminderOffsets';
import { Alert, Card, EmptyState, PageHeader, Spinner } from '../components/ui';

type Tab = 'all' | 'today' | 'upcoming' | 'past' | 'cancelled';
type EventDetail = Awaited<ReturnType<typeof api.events.get>>;

const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今天' },
  { key: 'upcoming', label: '即将开始' },
  { key: 'past', label: '已过去' },
  { key: 'cancelled', label: '已取消' },
];

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function EventsPage() {
  const [tab, setTab] = useState<Tab>('all');
  const [now, setNow] = useState(() => Date.now());
  const [events, setEvents] = useState<EventDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<EventDto | null>(null);
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const all: EventDto[] = [];
      let hasMore = true;
      while (hasMore) {
        const page = await api.events.list({ limit: 500, offset: all.length });
        all.push(...page.events);
        hasMore = page.hasMore;
      }
      setEvents(all);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '读取事件失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const grouped = useMemo(() => {
    const shanghaiDate = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const part = (type: string) => shanghaiDate.find((item) => item.type === type)!.value;
    const todayStart = Date.parse(`${part('year')}-${part('month')}-${part('day')}T00:00:00+08:00`);
    const tomorrowStart = todayStart + 86_400_000;
    const today: EventDto[] = [];
    const upcoming: EventDto[] = [];
    const past: EventDto[] = [];
    const cancelled: EventDto[] = [];
    for (const event of events) {
      if (event.status === 'cancelled') {
        cancelled.push(event);
        continue;
      }
      const start = new Date(event.startAt).getTime();
      const end = event.endAt ? new Date(event.endAt).getTime() : start;
      if (start < tomorrowStart && (start >= todayStart || end > todayStart)) today.push(event);
      if (start >= now) upcoming.push(event);
      else past.push(event);
    }
    today.sort((a, b) => a.startAt.localeCompare(b.startAt));
    upcoming.sort((a, b) => a.startAt.localeCompare(b.startAt));
    past.sort((a, b) => b.startAt.localeCompare(a.startAt));
    cancelled.sort((a, b) => b.startAt.localeCompare(a.startAt));
    return { all: [...upcoming, ...past, ...cancelled], today, upcoming, past, cancelled };
  }, [events, now]);

  async function toggleDetail(event: EventDto) {
    if (detail?.event.id === event.id) {
      setDetail(null);
      return;
    }
    setDetailLoadingId(event.id);
    setError(null);
    try {
      setDetail(await api.events.get(event.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '读取事件详情失败');
    } finally {
      setDetailLoadingId(null);
    }
  }

  async function remove(event: EventDto) {
    if (!window.confirm(`删除事件「${event.title}」？该操作不可恢复，未发送的提醒会一并取消。`)) return;
    setBusyId(event.id);
    setError(null);
    try {
      await api.events.remove(event.id);
      if (detail?.event.id === event.id) setDetail(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '删除事件失败');
    } finally {
      setBusyId(null);
    }
  }

  const shown = grouped[tab];

  return (
    <>
      <PageHeader
        title="事件"
        description="按时间发生的安排；在这里查看、编辑和删除事件"
        action={
          <button type="button" className="btn-primary" onClick={() => { setEditing(null); setDialogOpen(true); }}>
            <IconPlus width={18} height={18} /> 新增事件
          </button>
        }
      />

      <div className="mb-4 flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            aria-pressed={tab === key}
            className={`flex-1 whitespace-nowrap rounded-lg px-1.5 py-2 text-xs font-medium transition-colors sm:px-3 sm:text-sm ${tab === key ? 'bg-brand/10 text-brand' : 'text-muted hover:text-ink'}`}
          >
            {label}<span className="ml-1 text-[10px] opacity-70 sm:ml-1.5 sm:text-xs">{grouped[key].length}</span>
          </button>
        ))}
      </div>

      {error ? <div className="mb-4"><Alert>{error}</Alert></div> : null}

      <Card>
        {loading && events.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted"><Spinner /> 读取中…</div>
        ) : shown.length === 0 ? (
          <EmptyState
            icon={<IconEvent width={28} height={28} />}
            title={tab === 'all' ? '还没有事件' : tab === 'today' ? '今天没有事件' : tab === 'upcoming' ? '暂无即将开始的事件' : tab === 'past' ? '暂无过去的事件' : '暂无已取消的事件'}
            description={tab === 'all' || tab === 'today' || tab === 'upcoming' ? '点击「新增事件」安排一件事。' : undefined}
          />
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((event) => (
              <li key={event.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className={`break-words text-sm font-medium ${event.status === 'cancelled' ? 'text-muted line-through' : ''}`}>
                      {event.title}{event.status === 'cancelled' ? <span className="ml-2 text-xs font-normal text-muted">已取消</span> : null}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {formatDateTime(event.startAt)}
                      {event.endAt ? ` → ${formatDateTime(event.endAt)}` : ''}
                    </p>
                    {event.location ? <p className="mt-1 break-words text-xs text-muted">地点：{event.location}</p> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button type="button" className="rounded-lg px-2 py-1 text-xs text-muted hover:bg-canvas hover:text-ink" disabled={detailLoadingId === event.id} onClick={() => void toggleDetail(event)}>
                      {detail?.event.id === event.id ? '收起' : '详情'}
                    </button>
                    {event.status === 'active' ? (
                      <button type="button" className="rounded-lg px-2 py-1 text-xs text-muted hover:bg-canvas hover:text-ink" onClick={() => { setEditing(event); setDialogOpen(true); }}>
                        编辑
                      </button>
                    ) : null}
                    <button type="button" className="rounded-lg px-2 py-1 text-xs text-muted hover:bg-canvas hover:text-red-500" disabled={busyId === event.id} onClick={() => void remove(event)}>
                      删除
                    </button>
                  </div>
                </div>
                {detail?.event.id === event.id ? (
                  <dl className="mt-3 rounded-xl border border-line bg-canvas/50 p-3 text-sm">
                    <div><dt className="text-muted">开始</dt><dd>{formatDateTime(detail.event.startAt)}</dd></div>
                    {detail.event.endAt ? <div className="mt-2"><dt className="text-muted">结束</dt><dd>{formatDateTime(detail.event.endAt)}</dd></div> : null}
                    {detail.event.note ? <div className="mt-2"><dt className="text-muted">备注</dt><dd className="whitespace-pre-wrap break-words">{detail.event.note}</dd></div> : null}
                    <div className="mt-2"><dt className="text-muted">微信提醒</dt><dd>{detail.rule?.enabled ? `已开启 · ${(detail.rule.offsetsMinutes ?? []).map(formatOffset).join('、')}` : '未开启'}</dd></div>
                    <div className="mt-2"><dt className="text-muted">状态</dt><dd>{detail.event.status === 'active' ? '进行中' : '已取消'}</dd></div>
                  </dl>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <QuickAddDialog
        open={dialogOpen}
        mode="event"
        event={editing}
        onClose={() => { setDialogOpen(false); setEditing(null); }}
        onSaved={() => { setDetail(null); void load(); }}
      />
    </>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api, type CalendarItemDto, type EventDto } from '../api';
import { IconPlus } from '../components/Icons';
import { QuickAddDialog, type QuickAddMode } from '../components/QuickAdd';
import { formatOffset } from '../components/ReminderOffsets';
import { Alert, Card, PageHeader, Spinner, TypeBadge } from '../components/ui';

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

type FilterKey = 'event' | 'task' | 'subscription';
type ViewMode = 'month' | 'week' | 'day';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'event', label: '事件' },
  { key: 'task', label: '待办' },
  { key: 'subscription', label: '订阅' },
];

const VIEWS: { key: ViewMode; label: string }[] = [
  { key: 'month', label: '月' },
  { key: 'week', label: '周' },
  { key: 'day', label: '日' },
];

const TYPE_STYLE: Record<FilterKey, string> = {
  event: 'bg-event-soft text-event border-event/30',
  task: 'bg-task-soft text-task border-task/30',
  subscription: 'bg-subscription-soft text-subscription border-subscription/30',
};

type EventDetail = Awaited<ReturnType<typeof api.events.get>>;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 周一为一周起始 */
function startOfWeek(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = new Date(Date.UTC(y!, m! - 1, d!));
  const shift = (base.getUTCDay() + 6) % 7;
  base.setUTCDate(base.getUTCDate() - shift);
  return ymd(base);
}

function addDaysTo(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = new Date(Date.UTC(y!, m! - 1, d!));
  base.setUTCDate(base.getUTCDate() + days);
  return ymd(base);
}

function addMonthsTo(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const total = y! * 12 + (m! - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad(month)}-${pad(Math.min(d!, lastDay))}`;
}

export function CalendarPage() {
  const todayKey = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }, []);

  const [view, setView] = useState<ViewMode>('month');
  const [anchorDate, setAnchorDate] = useState(todayKey);
  const [active, setActive] = useState<Set<FilterKey>>(new Set(['event', 'task', 'subscription']));
  const [items, setItems] = useState<CalendarItemDto[]>([]);
  const [selected, setSelected] = useState<string>(todayKey);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<QuickAddMode>('event');
  const [editingEvent, setEditingEvent] = useState<EventDto | null>(null);
  const [eventDetail, setEventDetail] = useState<EventDetail | null>(null);
  const [eventError, setEventError] = useState<string | null>(null);
  const [eventLoadingId, setEventLoadingId] = useState<string | null>(null);
  const [busyEventId, setBusyEventId] = useState<string | null>(null);

  /** 当前视图需要覆盖的日期范围（含前后冗余，避免跨视图出现空洞） */
  const range = useMemo(() => {
    if (view === 'day') return { from: anchorDate, to: anchorDate };
    if (view === 'week') {
      const start = startOfWeek(anchorDate);
      return { from: start, to: addDaysTo(start, 6) };
    }
    const [y, m] = anchorDate.split('-').map(Number);
    const first = `${y}-${pad(m!)}-01`;
    const lastDay = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
    const last = `${y}-${pad(m!)}-${pad(lastDay)}`;
    // 网格会显示相邻月份的日子，前后各取一周
    return { from: addDaysTo(first, -7), to: addDaysTo(last, 7) };
  }, [view, anchorDate]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fromIso = new Date(`${range.from}T00:00:00+08:00`).toISOString();
      const toIso = new Date(`${range.to}T23:59:59+08:00`).toISOString();
      const res = await api.calendar.range({ from: fromIso, to: toIso });
      setItems(res.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '读取日历失败');
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () => items.filter((item) => active.has(item.type as FilterKey)),
    [items, active],
  );

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarItemDto[]>();
    for (const item of visible) {
      const list = map.get(item.date) ?? [];
      list.push(item);
      map.set(item.date, list);
    }
    return map;
  }, [visible]);

  function shift(delta: number) {
    setAnchorDate((prev) => {
      if (view === 'day') return addDaysTo(prev, delta);
      if (view === 'week') return addDaysTo(prev, delta * 7);
      return addMonthsTo(prev, delta);
    });
  }

  function toggleFilter(key: FilterKey) {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function openEvent(id: string) {
    setEventLoadingId(id);
    setError(null);
    setEventError(null);
    try {
      setEventDetail(await api.events.get(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '读取事件详情失败');
    } finally {
      setEventLoadingId(null);
    }
  }

  async function removeEvent(event: EventDto) {
    if (!window.confirm(`删除事件「${event.title}」？该操作不可恢复，未发送的提醒会一并取消。`)) return;
    setBusyEventId(event.id);
    setEventError(null);
    try {
      await api.events.remove(event.id);
      setEventDetail(null);
      await load();
    } catch (err) {
      setEventError(err instanceof ApiError ? err.message : '删除事件失败');
    } finally {
      setBusyEventId(null);
    }
  }

  function editEvent(event: EventDto) {
    setEventDetail(null);
    setEditingEvent(event);
    setDialogMode('event');
    setDialogOpen(true);
  }

  function renderCalendarTitle(item: CalendarItemDto) {
    if (item.type !== 'event') return <span>{item.title}</span>;
    return (
      <button
        type="button"
        className="text-left font-medium text-event underline decoration-event/30 underline-offset-2 hover:decoration-event"
        disabled={eventLoadingId === item.id}
        onClick={() => void openEvent(item.id)}
        aria-label={`查看事件「${item.title}」详情`}
      >
        {item.title}
      </button>
    );
  }

  const monthCells = useMemo(() => {
    const [y, m] = anchorDate.split('-').map(Number);
    const first = new Date(Date.UTC(y!, m! - 1, 1));
    const leading = (first.getUTCDay() + 6) % 7;
    const daysInMonth = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
    const total = Math.ceil((leading + daysInMonth) / 7) * 7;
    return Array.from({ length: total }, (_, index) => {
      const offset = index - leading + 1;
      const date = new Date(Date.UTC(y!, m! - 1, offset));
      return { key: ymd(date), day: date.getUTCDate(), inMonth: offset >= 1 && offset <= daysInMonth };
    });
  }, [anchorDate]);

  const weekDays = useMemo(() => {
    const start = startOfWeek(anchorDate);
    return Array.from({ length: 7 }, (_, i) => {
      const key = addDaysTo(start, i);
      return { key, label: WEEK_LABELS[i]!, day: Number(key.split('-')[2]) };
    });
  }, [anchorDate]);

  const rangeLabel = useMemo(() => {
    if (view === 'day') return anchorDate;
    if (view === 'week') {
      const start = startOfWeek(anchorDate);
      return `${start} ~ ${addDaysTo(start, 6)}`;
    }
    const [y, m] = anchorDate.split('-').map(Number);
    return `${y} 年 ${m} 月`;
  }, [view, anchorDate]);

  function ItemChip({ item, compact = false }: { item: CalendarItemDto; compact?: boolean }) {
    return (
      <div
        className={`truncate rounded border px-1 py-0.5 leading-tight ${TYPE_STYLE[item.type]} ${
          item.inactive ? 'opacity-50 line-through' : ''
        } ${compact ? 'text-[10px]' : 'text-xs'}`}
        title={`${item.title}${item.time ? ` ${item.time}` : ''}`}
      >
        {item.time ? <span className="font-medium">{item.time} </span> : null}
        {item.title}
      </div>
    );
  }

  const selectedItems = byDate.get(selected) ?? [];
  const dayItems = byDate.get(anchorDate) ?? [];
  const mobileAgendaDates = view === 'month'
    ? monthCells.filter((cell) => cell.inMonth && (byDate.get(cell.key)?.length ?? 0) > 0).map((cell) => cell.key)
    : weekDays.filter((day) => (byDate.get(day.key)?.length ?? 0) > 0).map((day) => day.key);

  function MobileAgenda() {
    return (
      <div className="border-t border-line px-4 py-4 sm:hidden">
        <h3 className="mb-3 text-sm font-semibold">{view === 'month' ? '本月安排' : '本周安排'}</h3>
        {mobileAgendaDates.length === 0 ? (
          <p className="py-5 text-sm text-muted">这段时间没有安排</p>
        ) : (
          <div className="space-y-4">
            {mobileAgendaDates.map((date) => (
              <section key={date} id={`agenda-${date}`} className="scroll-mt-20">
                <h4 className={`mb-1.5 text-sm font-medium ${date === todayKey ? 'text-brand' : 'text-ink'}`}>
                  {date} · 周{WEEK_LABELS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7]}
                </h4>
                <ul className="divide-y divide-line rounded-xl border border-line bg-surface px-3">
                  {(byDate.get(date) ?? []).map((item) => (
                    <li key={`${item.type}-${item.id}`} className="flex min-w-0 items-start gap-2.5 py-2.5">
                      <span className="w-11 shrink-0 pt-0.5 text-xs tabular-nums text-muted">
                        {item.allDay ? '全天' : item.time}
                      </span>
                      <TypeBadge type={item.type} />
                      <span className={`min-w-0 flex-1 break-words text-sm leading-5 ${item.inactive ? 'text-muted line-through' : ''}`}>
                        {renderCalendarTitle(item)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="日历"
        description="点击事件标题可查看详情、编辑或删除；也可按类型筛选"
        action={
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setEditingEvent(null);
              setDialogMode('event');
              setDialogOpen(true);
            }}
          >
            <IconPlus width={18} height={18} />
            新增事件
          </button>
        }
      />

      {error ? (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      ) : null}

      <Card className="!p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-ghost !px-3 !py-1.5" onClick={() => shift(-1)} aria-label="上一个">
              ‹
            </button>
            <span className="min-w-[10rem] text-center text-sm font-semibold">{rangeLabel}</span>
            <button type="button" className="btn-ghost !px-3 !py-1.5" onClick={() => shift(1)} aria-label="下一个">
              ›
            </button>
            <button
              type="button"
              className="btn-ghost !px-3 !py-1.5"
              onClick={() => {
                setAnchorDate(todayKey);
                setSelected(todayKey);
              }}
            >
              今天
            </button>
            {loading ? <Spinner className="ml-1 text-muted" /> : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* 视图切换：月 / 周 / 日（PRD FR-04） */}
            <div className="flex gap-1 rounded-xl border border-line p-0.5">
              {VIEWS.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => {
                    if (v.key === 'day') setAnchorDate(selected);
                    setView(v.key);
                  }}
                  aria-pressed={view === v.key}
                  className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                    view === v.key ? 'bg-brand/10 text-brand' : 'text-muted hover:text-ink'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>

            {FILTERS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => toggleFilter(key)}
                aria-pressed={active.has(key)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  active.has(key) ? 'border-brand/30 bg-brand/10 text-brand' : 'border-line text-muted hover:text-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* ── 月视图 ── */}
        {view === 'month' ? (
          <>
            <div className="grid grid-cols-7 border-b border-line bg-canvas/50 text-center text-xs font-medium text-muted">
              {WEEK_LABELS.map((label) => (
                <div key={label} className="py-2">
                  {label}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {monthCells.map((cell) => {
                const dayItems = byDate.get(cell.key) ?? [];
                const isToday = cell.key === todayKey;
                const isSelected = cell.key === selected;
                return (
                  <button
                    key={cell.key}
                    type="button"
                    onClick={() => {
                      setSelected(cell.key);
                      if (!cell.inMonth) setAnchorDate(cell.key);
                      document.getElementById(`agenda-${cell.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                    className={`min-h-[3.25rem] border-b border-r border-line p-1 text-left align-top transition-colors last:border-r-0 sm:min-h-[6.5rem] sm:p-1.5 ${
                      cell.inMonth ? '' : 'bg-canvas/40'
                    } ${isSelected ? 'ring-1 ring-inset ring-brand/40' : 'hover:bg-canvas/70'}`}
                    aria-label={`${cell.key}，${dayItems.length} 项`}
                    aria-pressed={isSelected}
                  >
                    <div
                      className={`mb-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                        isToday ? 'bg-brand font-semibold text-white' : cell.inMonth ? 'text-ink' : 'text-muted/60'
                      }`}
                    >
                      {cell.day}
                    </div>
                    <div className="flex flex-wrap gap-0.5 sm:hidden" aria-hidden="true">
                      {dayItems.slice(0, 4).map((item) => (
                        <span key={`${item.type}-${item.id}`} className={`h-1.5 w-1.5 rounded-full ${item.type === 'event' ? 'bg-event' : item.type === 'task' ? 'bg-task' : 'bg-subscription'}`} />
                      ))}
                      {dayItems.length > 4 ? <span className="text-[9px] leading-none text-muted">+{dayItems.length - 4}</span> : null}
                    </div>
                    <div className="hidden space-y-0.5 sm:block">
                      {dayItems.slice(0, 3).map((item) => (
                        <ItemChip key={`${item.type}-${item.id}`} item={item} compact />
                      ))}
                      {dayItems.length > 3 ? (
                        <div className="px-1 text-[10px] text-muted">+{dayItems.length - 3} 项</div>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
            <MobileAgenda />
          </>
        ) : null}

        {/* ── 周视图 ── */}
        {view === 'week' ? (
          <>
            <div className="hidden grid-cols-7 border-b border-line bg-canvas/50 text-center text-xs font-medium text-muted sm:grid">
              {weekDays.map((d) => (
                <div key={d.key} className="py-2">
                  {d.label}
                </div>
              ))}
            </div>
            <div className="hidden grid-cols-7 sm:grid">
              {weekDays.map((d) => {
                const dayItems = byDate.get(d.key) ?? [];
                const isToday = d.key === todayKey;
                return (
                  <button
                    key={d.key}
                    type="button"
                    onClick={() => {
                      setSelected(d.key);
                      setView('day');
                      setAnchorDate(d.key);
                    }}
                    className={`min-h-[14rem] border-r border-line p-1.5 text-left align-top transition-colors last:border-r-0 hover:bg-canvas/70 ${
                      d.key === selected ? 'ring-1 ring-inset ring-brand/40' : ''
                    }`}
                    aria-label={`${d.key}，${dayItems.length} 项`}
                  >
                    <div
                      className={`mb-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                        isToday ? 'bg-brand font-semibold text-white' : 'text-ink'
                      }`}
                    >
                      {d.day}
                    </div>
                    {/* 周视图不截断，尽量把当天安排铺开 */}
                    <div className="space-y-0.5">
                      {dayItems.map((item) => (
                        <ItemChip key={`${item.type}-${item.id}`} item={item} />
                      ))}
                    </div>
                  </button>
                );
              })}
            </div>
            <MobileAgenda />
          </>
        ) : null}

        {/* ── 日视图 ── */}
        {view === 'day' ? (
          <div className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">{anchorDate}</h3>
              <span className="text-xs text-muted">{dayItems.length} 项</span>
            </div>
            {dayItems.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted">这一天没有安排</p>
            ) : (
              <ul className="divide-y divide-line">
                {dayItems.map((item) => (
                  <li key={`${item.type}-${item.id}`} className="flex items-center gap-3 py-3 first:pt-0">
                    <span className="w-14 shrink-0 text-xs text-muted">{item.allDay ? '全天' : item.time}</span>
                    <TypeBadge type={item.type} />
                    <span className={`min-w-0 flex-1 break-words text-sm ${item.inactive ? 'text-muted line-through' : ''}`}>
                      {renderCalendarTitle(item)}
                    </span>
                    {typeof item.meta?.location === 'string' && item.meta.location ? (
                      <span className="shrink-0 text-xs text-muted">{item.meta.location}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setEditingEvent(null);
                  setDialogMode('event');
                  setDialogOpen(true);
                }}
              >
                新增事件
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setEditingEvent(null);
                  setDialogMode('task');
                  setDialogOpen(true);
                }}
              >
                新增待办
              </button>
            </div>
          </div>
        ) : null}
      </Card>

      <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-muted">
        <TypeBadge type="event" />
        <TypeBadge type="task" />
        <span className="flex items-center gap-1.5">
          <TypeBadge type="subscription" />
          <span>续费 / 到期</span>
        </span>
      </div>

      {/* 月/周视图下点击某天后展示该日明细 */}
      {view !== 'day' ? (
        <Card title={`${selected} 的安排`} subtitle={`${selectedItems.length} 项`} className="mt-4 hidden sm:block">
          {selectedItems.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">这一天没有安排</p>
          ) : (
            <ul className="divide-y divide-line">
              {selectedItems.map((item) => (
                <li key={`${item.type}-${item.id}`} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <TypeBadge type={item.type} />
                  <span className={`min-w-0 flex-1 break-words text-sm ${item.inactive ? 'text-muted line-through' : ''}`}>
                    {renderCalendarTitle(item)}
                  </span>
                  <span className="shrink-0 text-xs text-muted">{item.allDay ? '全天' : item.time}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setEditingEvent(null);
                setDialogMode('event');
                setDialogOpen(true);
              }}
            >
              新增事件
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setEditingEvent(null);
                setDialogMode('task');
                setDialogOpen(true);
              }}
            >
              新增待办
            </button>
          </div>
        </Card>
      ) : null}

      {eventDetail ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={() => setEventDetail(null)}>
          <div
            className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-pop sm:rounded-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="事件详情"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="chip bg-event-soft text-event">事件</span>
                <h2 className="mt-2 break-words text-lg font-semibold">{eventDetail.event.title}</h2>
              </div>
              <button type="button" className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => setEventDetail(null)}>关闭</button>
            </div>
            <dl className="mt-4 space-y-2 text-sm">
              <div><dt className="text-muted">开始</dt><dd>{new Date(eventDetail.event.startAt).toLocaleString('zh-CN', { hour12: false })}</dd></div>
              {eventDetail.event.endAt ? <div><dt className="text-muted">结束</dt><dd>{new Date(eventDetail.event.endAt).toLocaleString('zh-CN', { hour12: false })}</dd></div> : null}
              {eventDetail.event.location ? <div><dt className="text-muted">地点</dt><dd className="break-words">{eventDetail.event.location}</dd></div> : null}
              {eventDetail.event.note ? <div><dt className="text-muted">备注</dt><dd className="whitespace-pre-wrap break-words">{eventDetail.event.note}</dd></div> : null}
              <div><dt className="text-muted">状态</dt><dd>{eventDetail.event.status === 'active' ? '进行中' : '已取消'}</dd></div>
              <div><dt className="text-muted">微信提醒</dt><dd>{eventDetail.rule?.enabled ? `已开启 · ${(eventDetail.rule.offsetsMinutes ?? []).map(formatOffset).join('、')}` : '未开启'}</dd></div>
            </dl>
            {eventError ? <div className="mt-3"><Alert>{eventError}</Alert></div> : null}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="btn-ghost text-red-500" disabled={busyEventId === eventDetail.event.id} onClick={() => void removeEvent(eventDetail.event)}>
                删除
              </button>
              {eventDetail.event.status === 'active' ? (
                <button type="button" className="btn-primary" onClick={() => editEvent(eventDetail.event)}>编辑</button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <QuickAddDialog
        open={dialogOpen}
        mode={dialogMode}
        event={editingEvent}
        onClose={() => {
          setDialogOpen(false);
          setEditingEvent(null);
        }}
        onSaved={() => void load()}
      />
    </>
  );
}

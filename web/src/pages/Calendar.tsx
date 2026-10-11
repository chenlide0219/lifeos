import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api, type CalendarItemDto } from '../api';
import { IconPlus } from '../components/Icons';
import { QuickAddDialog, type QuickAddMode } from '../components/QuickAdd';
import { Alert, Card, PageHeader, Spinner, TypeBadge } from '../components/ui';

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

type FilterKey = 'event' | 'task' | 'subscription';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'event', label: '事件' },
  { key: 'task', label: '待办' },
  { key: 'subscription', label: '订阅' },
];

const TYPE_STYLE: Record<FilterKey, string> = {
  event: 'bg-event-soft text-event border-event/30',
  task: 'bg-task-soft text-task border-task/30',
  subscription: 'bg-subscription-soft text-subscription border-subscription/30',
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function CalendarPage() {
  const today = new Date();
  const todayKey = ymd(today.getFullYear(), today.getMonth() + 1, today.getDate());

  const [cursor, setCursor] = useState({ year: today.getFullYear(), month: today.getMonth() + 1 });
  const [active, setActive] = useState<Set<FilterKey>>(new Set(['event', 'task', 'subscription']));
  const [items, setItems] = useState<CalendarItemDto[]>([]);
  const [selected, setSelected] = useState<string>(todayKey);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<QuickAddMode>('event');

  const cells = useMemo(() => {
    const firstDay = new Date(Date.UTC(cursor.year, cursor.month - 1, 1));
    const leading = (firstDay.getUTCDay() + 6) % 7; // 周一为一周起始
    const daysInMonth = new Date(Date.UTC(cursor.year, cursor.month, 0)).getUTCDate();
    const total = Math.ceil((leading + daysInMonth) / 7) * 7;

    return Array.from({ length: total }, (_, index) => {
      const dayOffset = index - leading + 1;
      const date = new Date(Date.UTC(cursor.year, cursor.month - 1, dayOffset));
      return {
        key: date.toISOString().slice(0, 10),
        day: date.getUTCDate(),
        inMonth: dayOffset >= 1 && dayOffset <= daysInMonth,
      };
    });
  }, [cursor]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 多取前后各一周，避免跨月时网格出现空洞
      const from = new Date(Date.UTC(cursor.year, cursor.month - 1, 1) - 7 * 86_400_000);
      const to = new Date(Date.UTC(cursor.year, cursor.month, 0) + 7 * 86_400_000);
      const res = await api.calendar.range({ from: from.toISOString(), to: to.toISOString() });
      setItems(res.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '读取日历失败');
    } finally {
      setLoading(false);
    }
  }, [cursor]);

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

  function shiftMonth(delta: number) {
    setCursor((prev) => {
      const total = prev.year * 12 + (prev.month - 1) + delta;
      return { year: Math.floor(total / 12), month: (total % 12) + 1 };
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

  const selectedItems = byDate.get(selected) ?? [];

  return (
    <>
      <PageHeader
        title="日历"
        description="事件、待办与订阅周期事项统一展示，可按类型筛选"
        action={
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
        }
      />

      {error ? (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      ) : null}

      <Card className="!p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex items-center gap-2">
            <button type="button" className="btn-ghost !px-3 !py-1.5" onClick={() => shiftMonth(-1)} aria-label="上个月">
              ‹
            </button>
            <span className="min-w-[7.5rem] text-center text-sm font-semibold">
              {cursor.year} 年 {cursor.month} 月
            </span>
            <button type="button" className="btn-ghost !px-3 !py-1.5" onClick={() => shiftMonth(1)} aria-label="下个月">
              ›
            </button>
            <button
              type="button"
              className="btn-ghost !px-3 !py-1.5"
              onClick={() => {
                setCursor({ year: today.getFullYear(), month: today.getMonth() + 1 });
                setSelected(todayKey);
              }}
            >
              今天
            </button>
            {loading ? <Spinner className="ml-1 text-muted" /> : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
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

        <div className="grid grid-cols-7 border-b border-line bg-canvas/50 text-center text-xs font-medium text-muted">
          {WEEK_LABELS.map((label) => (
            <div key={label} className="py-2">
              {label}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7">
          {cells.map((cell) => {
            const dayItems = byDate.get(cell.key) ?? [];
            const isToday = cell.key === todayKey;
            const isSelected = cell.key === selected;

            return (
              <button
                key={cell.key}
                type="button"
                onClick={() => setSelected(cell.key)}
                className={`min-h-[5.5rem] border-b border-r border-line p-1.5 text-left align-top transition-colors last:border-r-0 sm:min-h-[6.5rem] ${
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

                <div className="space-y-0.5">
                  {dayItems.slice(0, 3).map((item) => (
                    <div
                      key={`${item.type}-${item.id}`}
                      className={`truncate rounded border px-1 py-0.5 text-[10px] leading-tight ${TYPE_STYLE[item.type]} ${
                        item.inactive ? 'opacity-50 line-through' : ''
                      }`}
                      title={`${item.title}${item.time ? ` ${item.time}` : ''}`}
                    >
                      {item.time ? <span className="font-medium">{item.time} </span> : null}
                      {item.title}
                    </div>
                  ))}
                  {dayItems.length > 3 ? (
                    <div className="px-1 text-[10px] text-muted">+{dayItems.length - 3} 项</div>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-muted">
        <TypeBadge type="event" />
        <TypeBadge type="task" />
        <span className="flex items-center gap-1.5">
          <TypeBadge type="subscription" />
          <span>续费 / 到期</span>
        </span>
      </div>

      <Card title={`${selected} 的安排`} subtitle={`${selectedItems.length} 项`} className="mt-4">
        {selectedItems.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">这一天没有安排</p>
        ) : (
          <ul className="divide-y divide-line">
            {selectedItems.map((item) => (
              <li key={`${item.type}-${item.id}`} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <TypeBadge type={item.type} />
                <span className={`min-w-0 flex-1 truncate text-sm ${item.inactive ? 'text-muted line-through' : ''}`}>
                  {item.title}
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
              setDialogMode('task');
              setDialogOpen(true);
            }}
          >
            新增待办
          </button>
        </div>
      </Card>

      <QuickAddDialog
        open={dialogOpen}
        mode={dialogMode}
        onClose={() => setDialogOpen(false)}
        onSaved={() => void load()}
      />
    </>
  );
}

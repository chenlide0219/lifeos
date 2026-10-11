import { useMemo, useState } from 'react';
import { Card, PageHeader, TypeBadge } from '../components/ui';

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

type FilterKey = 'event' | 'task' | 'subscription';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'event', label: '事件' },
  { key: 'task', label: '待办' },
  { key: 'subscription', label: '订阅' },
];

function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function CalendarPage() {
  const today = new Date();
  const [cursor, setCursor] = useState({ year: today.getFullYear(), month: today.getMonth() + 1 });
  const [active, setActive] = useState<Set<FilterKey>>(new Set(['event', 'task', 'subscription']));

  const todayKey = ymd(today.getFullYear(), today.getMonth() + 1, today.getDate());

  const cells = useMemo(() => {
    const firstDay = new Date(Date.UTC(cursor.year, cursor.month - 1, 1));
    // 周一为一周起始
    const leading = (firstDay.getUTCDay() + 6) % 7;
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

  return (
    <>
      <PageHeader
        title="日历"
        description="事件、待办与订阅周期事项统一展示，可按类型筛选"
      />

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
              onClick={() => setCursor({ year: today.getFullYear(), month: today.getMonth() + 1 })}
            >
              今天
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => toggleFilter(key)}
                aria-pressed={active.has(key)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  active.has(key)
                    ? 'border-brand/30 bg-brand/10 text-brand'
                    : 'border-line text-muted hover:text-ink'
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
            const isToday = cell.key === todayKey;
            return (
              <div
                key={cell.key}
                className={`min-h-[5.5rem] border-b border-r border-line p-1.5 last:border-r-0 sm:min-h-[6.5rem] ${
                  cell.inMonth ? '' : 'bg-canvas/40'
                }`}
              >
                <div
                  className={`mb-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                    isToday
                      ? 'bg-brand font-semibold text-white'
                      : cell.inMonth
                        ? 'text-ink'
                        : 'text-muted/60'
                  }`}
                >
                  {cell.day}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-muted">
        {/* TypeBadge 自带文字标签，图例不再重复写一遍 */}
        <TypeBadge type="event" />
        <TypeBadge type="task" />
        <span className="flex items-center gap-1.5">
          <TypeBadge type="subscription" />
          <span>续费 / 到期</span>
        </span>
        <span className="ml-auto">阶段 2 接入数据后，条目将按类型着色显示</span>
      </div>
    </>
  );
}

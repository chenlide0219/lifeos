import { useEffect, useState, type FormEvent } from 'react';
import {
  ApiError,
  api,
  type EventDto,
  type ReminderResult,
  type TaskDto,
} from '../api';
import { Alert, Spinner } from './ui';

export type QuickAddMode = 'event' | 'task';

const PRESET_OFFSETS = [
  { minutes: 60, label: '提前 1 小时' },
  { minutes: 10, label: '提前 10 分钟' },
];

const CUSTOM_OFFSETS = [
  { minutes: 1440, label: '1 天' },
  { minutes: 120, label: '2 小时' },
  { minutes: 30, label: '30 分钟' },
  { minutes: 5, label: '5 分钟' },
];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** <input type="datetime-local"> 需要浏览器本地时间的 YYYY-MM-DDTHH:mm */
function toLocalInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultStart(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return toLocalInput(d);
}

function defaultDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

type Props = {
  open: boolean;
  mode: QuickAddMode;
  /** 传入则为编辑模式 */
  event?: EventDto | null;
  task?: TaskDto | null;
  onClose: () => void;
  onSaved: (result: { kind: QuickAddMode; reminder: ReminderResult }) => void;
};

export function QuickAddDialog({ open, mode: initialMode, event, task, onClose, onSaved }: Props) {
  const editing = Boolean(event || task);
  const [mode, setMode] = useState<QuickAddMode>(initialMode);
  const [title, setTitle] = useState('');
  const [startAt, setStartAt] = useState(defaultStart);
  const [endAt, setEndAt] = useState('');
  const [location, setLocation] = useState('');
  const [dueDate, setDueDate] = useState(defaultDate);
  const [dueTime, setDueTime] = useState('');
  const [note, setNote] = useState('');
  const [reminderEnabled, setReminderEnabled] = useState(false);
  const [offsets, setOffsets] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 打开时同步初值（编辑模式用记录填充）
  useEffect(() => {
    if (!open) return;
    setError(null);
    setNotice(null);
    if (event) {
      setMode('event');
      setTitle(event.title);
      setStartAt(toLocalInput(new Date(event.startAt)));
      setEndAt(event.endAt ? toLocalInput(new Date(event.endAt)) : '');
      setLocation(event.location ?? '');
      setNote(event.note ?? '');
    } else if (task) {
      setMode('task');
      setTitle(task.title);
      setDueDate(task.dueDate ?? defaultDate());
      setDueTime(task.dueTime ? task.dueTime.slice(0, 5) : '');
      setNote(task.note ?? '');
    } else {
      setMode(initialMode);
      setTitle('');
      setStartAt(defaultStart());
      setEndAt('');
      setLocation('');
      setDueDate(defaultDate());
      setDueTime('');
      setNote('');
      setReminderEnabled(false);
      setOffsets([]);
    }
  }, [open, event, task, initialMode]);

  if (!open) return null;

  function toggleOffset(minutes: number) {
    setOffsets((prev) =>
      prev.includes(minutes) ? prev.filter((m) => m !== minutes) : [...prev, minutes].sort((a, b) => b - a),
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    // 待办要精确提醒必须有具体时刻（PRD FR-02）
    if (mode === 'task' && reminderEnabled && offsets.length > 0 && !dueTime) {
      setError('设置精确提醒需要补充具体时刻（全天待办无法精确提醒）');
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        title,
        reminderEnabled,
        reminderOffsets: reminderEnabled ? offsets : [],
        source: 'manual' as const,
      };

      let reminder: ReminderResult;
      if (mode === 'event') {
        const body = {
          ...payload,
          startAt: new Date(startAt).toISOString(),
          endAt: endAt ? new Date(endAt).toISOString() : null,
          location: location || null,
          note: note || null,
        };
        const res = event ? await api.events.update(event.id, body) : await api.events.create(body);
        reminder = res.reminder;
      } else {
        const body = {
          ...payload,
          dueDate: dueDate || null,
          dueTime: dueTime || null,
          note: note || null,
        };
        const res = task ? await api.tasks.update(task.id, body) : await api.tasks.create(body);
        reminder = res.reminder;
      }

      const skipped = reminder.skippedPast > 0 ? `，${reminder.skippedPast} 条提醒时间已过、按政策不补发` : '';
      setNotice(`已保存${skipped}`);
      onSaved({ kind: mode, reminder });
      if (reminder.skippedPast === 0) onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <div
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-pop sm:rounded-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? '编辑' : '新增'}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{editing ? '编辑' : '新增'}</h2>
          <button type="button" onClick={onClose} className="btn-ghost !px-3 !py-1.5 text-xs">
            取消
          </button>
        </div>

        {!editing ? (
          <div className="mb-4 flex gap-1 rounded-xl border border-line p-1">
            {(['event', 'task'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  mode === m ? 'bg-brand/10 text-brand' : 'text-muted hover:text-ink'
                }`}
              >
                {m === 'event' ? '事件' : '待办'}
              </button>
            ))}
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="space-y-3.5">
          <div>
            <label className="label" htmlFor="qa-title">
              标题
            </label>
            <input
              id="qa-title"
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={mode === 'event' ? '例如：课题组会议' : '例如：提交周报'}
              required
              autoFocus
            />
          </div>

          {mode === 'event' ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="qa-start">
                    开始时间
                  </label>
                  <input
                    id="qa-start"
                    type="datetime-local"
                    className="input"
                    value={startAt}
                    onChange={(e) => setStartAt(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="label" htmlFor="qa-end">
                    结束时间（可选）
                  </label>
                  <input
                    id="qa-end"
                    type="datetime-local"
                    className="input"
                    value={endAt}
                    onChange={(e) => setEndAt(e.target.value)}
                  />
                </div>
              </div>
              <div>
                <label className="label" htmlFor="qa-location">
                  地点（可选）
                </label>
                <input
                  id="qa-location"
                  className="input"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="例如：科研楼 302"
                />
              </div>
            </>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="qa-date">
                  截止日期（可选）
                </label>
                <input
                  id="qa-date"
                  type="date"
                  className="input"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="qa-time">
                  具体时刻（可选）
                </label>
                <input
                  id="qa-time"
                  type="time"
                  className="input"
                  value={dueTime}
                  onChange={(e) => setDueTime(e.target.value)}
                />
                <p className="mt-1 text-xs text-muted">留空为全天待办，全天待办不能精确到分钟提醒</p>
              </div>
            </div>
          )}

          <div>
            <label className="label" htmlFor="qa-note">
              备注（可选）
            </label>
            <textarea
              id="qa-note"
              className="input min-h-[4.5rem] resize-y"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          <div className="rounded-xl border border-line p-3.5">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span className="text-sm font-medium">微信提醒</span>
              <input
                type="checkbox"
                className="h-4 w-4 accent-[#6366f1]"
                checked={reminderEnabled}
                onChange={(e) => {
                  setReminderEnabled(e.target.checked);
                  if (e.target.checked && offsets.length === 0) setOffsets([60, 10]);
                }}
              />
            </label>

            {reminderEnabled ? (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-muted">提前量</p>
                <div className="flex flex-wrap gap-2">
                  {PRESET_OFFSETS.map(({ minutes, label }) => (
                    <button
                      key={minutes}
                      type="button"
                      onClick={() => toggleOffset(minutes)}
                      aria-pressed={offsets.includes(minutes)}
                      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                        offsets.includes(minutes)
                          ? 'border-brand/30 bg-brand/10 text-brand'
                          : 'border-line text-muted hover:text-ink'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                  {CUSTOM_OFFSETS.map(({ minutes, label }) => (
                    <button
                      key={minutes}
                      type="button"
                      onClick={() => toggleOffset(minutes)}
                      aria-pressed={offsets.includes(minutes)}
                      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                        offsets.includes(minutes)
                          ? 'border-brand/30 bg-brand/10 text-brand'
                          : 'border-line text-muted hover:text-ink'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {offsets.length === 0 ? (
                  <p className="text-xs text-subscription">未选择提前量，保存后不会产生任何提醒</p>
                ) : null}
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted">默认关闭；需要提醒时打开并选择提前量</p>
            )}
          </div>

          {error ? <Alert>{error}</Alert> : null}
          {notice ? <Alert tone="warn">{notice}</Alert> : null}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn-ghost" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? <Spinner /> : null}
              {editing ? '保存修改' : '创建'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

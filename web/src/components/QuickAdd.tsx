import { useDialog } from '../hooks/useDialog';
import { useEffect, useState, type FormEvent } from 'react';
import {
  ApiError,
  api,
  type EventDto,
  type ReminderResult,
  type TaskDto,
} from '../api';
import { OffsetChips } from './ReminderOffsets';
import { TimeInput } from './TimeInput';
import { Alert, Spinner } from './ui';

export type QuickAddMode = 'event' | 'task';

/** 类型定义放在切换处，避免把"带时刻的待办"误当成事件 */
const KIND_HINT = '事件＝按时间发生的安排；待办＝需要完成的行动（待办设了具体时刻也仍是待办）';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 绝对时刻 → 设备本地 "YYYY-MM-DD" 与 "HH:mm"（表单回显用） */
function splitLocal(date: Date): { date: string; time: string } {
  const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const [d, t] = local.split('T');
  return { date: d!, time: t!.slice(0, 5) };
}

function defaultDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function defaultTime(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return `${pad(d.getHours())}:00`;
}

/** 日期 + HH:mm → ISO 绝对时刻；任一缺失或非法返回 null */
function buildInstant(date: string, time: string): string | null {
  if (!date || !time) return null;
  const d = new Date(`${date}T${time}`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
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
  const [startDate, setStartDate] = useState(defaultDate);
  const [startTime, setStartTime] = useState(defaultTime);
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('');
  const [location, setLocation] = useState('');
  const [dueDate, setDueDate] = useState(defaultDate);
  const [dueTime, setDueTime] = useState('');
  const [note, setNote] = useState('');
  const [reminderEnabled, setReminderEnabled] = useState(false);
  const [offsets, setOffsets] = useState<number[]>([]);
  // 编辑模式下提醒设置来自详情接口；读取完成前提交不携带提醒字段，
  // 服务端会保留原规则 —— 这样"读失败"也不会把已有提醒静默抹掉
  const [reminderLoaded, setReminderLoaded] = useState(!editing);
  const [startTimeInvalid, setStartTimeInvalid] = useState(false);
  const [endTimeInvalid, setEndTimeInvalid] = useState(false);
  const [dueTimeInvalid, setDueTimeInvalid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 打开时同步初值（编辑模式用记录填充，并异步读取已保存的提醒规则）
  useEffect(() => {
    if (!open) return;
    setError(null);
    setNotice(null);
    setReminderLoaded(!editing);
    setReminderEnabled(false);
    setOffsets([]);
    setStartTimeInvalid(false);
    setEndTimeInvalid(false);
    setDueTimeInvalid(false);
    let cancelled = false;

    if (event) {
      setMode('event');
      setTitle(event.title);
      const start = splitLocal(new Date(event.startAt));
      setStartDate(start.date);
      setStartTime(start.time);
      if (event.endAt) {
        const end = splitLocal(new Date(event.endAt));
        setEndDate(end.date);
        setEndTime(end.time);
      } else {
        setEndDate('');
        setEndTime('');
      }
      setLocation(event.location ?? '');
      setNote(event.note ?? '');
      api.events
        .get(event.id)
        .then((d) => {
          if (cancelled) return;
          setReminderEnabled(d.rule?.enabled ?? false);
          setOffsets(d.rule?.offsetsMinutes ?? []);
          setReminderLoaded(true);
        })
        .catch(() => {
          if (!cancelled) setReminderLoaded(false);
        });
    } else if (task) {
      setMode('task');
      setTitle(task.title);
      setDueDate(task.dueDate ?? defaultDate());
      setDueTime(task.dueTime ? task.dueTime.slice(0, 5) : '');
      setNote(task.note ?? '');
      api.tasks
        .get(task.id)
        .then((d) => {
          if (cancelled) return;
          setReminderEnabled(d.rule?.enabled ?? false);
          setOffsets(d.rule?.offsetsMinutes ?? []);
          setReminderLoaded(true);
        })
        .catch(() => {
          if (!cancelled) setReminderLoaded(false);
        });
    } else {
      setMode(initialMode);
      setTitle('');
      setStartDate(defaultDate());
      setStartTime(defaultTime());
      setEndDate('');
      setEndTime('');
      setLocation('');
      setDueDate(defaultDate());
      setDueTime('');
      setNote('');
      setReminderEnabled(false);
      setOffsets([]);
      setReminderLoaded(true);
    }
    return () => {
      cancelled = true;
    };
  }, [open, event, task, initialMode]);

  const dialogRef = useDialog(open, onClose);

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

    if ((mode === 'event' && (startTimeInvalid || endTimeInvalid)) || (mode === 'task' && dueTimeInvalid)) {
      setError('请把时间的小时和分钟填写完整，并确认数值有效');
      return;
    }

    // 待办要精确提醒必须有具体时刻（PRD FR-02）
    if (mode === 'task' && reminderEnabled && offsets.length > 0 && !dueTime) {
      setError('设置精确提醒需要补充具体时刻（全天待办无法精确提醒）');
      return;
    }

    setSubmitting(true);
    try {
      // 编辑模式下若提醒规则尚未读到，就不携带提醒字段，服务端保留原规则
      const reminderFields = reminderLoaded
        ? { reminderEnabled, reminderOffsets: reminderEnabled ? offsets : [] }
        : {};

      let reminder: ReminderResult;
      if (mode === 'event') {
        const startIso = buildInstant(startDate, startTime);
        if (!startIso) {
          setError('请补充开始时间的日期和时刻（24 小时制，如 13:27）');
          return;
        }
        let endIso: string | null = null;
        if (endDate || endTime) {
          endIso = buildInstant(endDate, endTime);
          if (!endIso) {
            setError('结束时间需要同时有日期和时刻');
            return;
          }
        }
        const body = {
          title,
          source: 'manual' as const,
          ...reminderFields,
          startAt: startIso,
          endAt: endIso,
          location: location || null,
          note: note || null,
        };
        const res = event ? await api.events.update(event.id, body) : await api.events.create(body);
        reminder = res.reminder;
      } else {
        const body = {
          title,
          source: 'manual' as const,
          ...reminderFields,
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
        ref={dialogRef} tabIndex={-1} role="dialog"
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
          <div className="mb-4">
            <div className="flex gap-1 rounded-xl border border-line p-1">
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
            <p className="mt-1.5 px-1 text-xs text-muted">{KIND_HINT}</p>
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
                  <label className="label" htmlFor="qa-start-date">
                    开始日期
                  </label>
                  <input
                    id="qa-start-date"
                    type="date"
                    className="input"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="label" htmlFor="qa-start-time">
                    开始时间（24 小时制）
                  </label>
                  <TimeInput
                    id="qa-start-time"
                    ariaLabel="开始时间"
                    value={startTime}
                    onChange={setStartTime}
                    onInvalidChange={setStartTimeInvalid}
                  />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="qa-end-date">
                    结束日期（可选）
                  </label>
                  <input
                    id="qa-end-date"
                    type="date"
                    className="input"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="qa-end-time">
                    结束时间（可选）
                  </label>
                  <TimeInput
                    id="qa-end-time"
                    ariaLabel="结束时间"
                    value={endTime}
                    onChange={setEndTime}
                    onInvalidChange={setEndTimeInvalid}
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
                  具体时刻（可选，24 小时制）
                </label>
                <TimeInput id="qa-time" ariaLabel="具体时刻" value={dueTime} onChange={setDueTime} onInvalidChange={setDueTimeInvalid} />
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
                className="h-4 w-4 accent-brand"
                checked={reminderEnabled}
                disabled={editing && !reminderLoaded}
                onChange={(e) => {
                  setReminderEnabled(e.target.checked);
                  if (e.target.checked && offsets.length === 0) setOffsets([60, 10]);
                }}
              />
            </label>

            {editing && !reminderLoaded ? (
              <p className="mt-2 text-xs text-muted">提醒设置读取中…；保存不会改动已有提醒</p>
            ) : reminderEnabled ? (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-muted">提前量（可多选）</p>
                <OffsetChips selected={offsets} onToggle={toggleOffset} />
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

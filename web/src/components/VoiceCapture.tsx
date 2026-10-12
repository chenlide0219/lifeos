import { useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import type { AiDraft } from '@shared/types';
import { useRecorder } from '../hooks/useRecorder';
import { IconMic } from './Icons';
import { OffsetChips } from './ReminderOffsets';
import { TimeInput } from './TimeInput';
import { Alert, Spinner } from './ui';

type Stage = 'capture' | 'transcript' | 'draft';

/** 与手动新增一致：类型切换处给出简短定义 */
const KIND_HINT = '事件＝按时间发生的安排；待办＝需要完成的行动（待办设了具体时刻也仍是待办）';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** ISO → 设备本地 "YYYY-MM-DD" 与 "HH:mm" */
function splitLocal(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/**
 * 语音 → 打字稿 → 结构化草稿 → 用户确认。
 *
 * 关键约束（PRD FR-03）：
 * - 用户确认之前**不保存任何正式事项、不生成通知任务**；
 * - 含糊时间必须回问，不擅自补全；
 * - 语音或解析失败不产生半成品，可直接转手动录入。
 */
export function VoiceCapture({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const recorder = useRecorder();
  const [stage, setStage] = useState<Stage>('capture');
  const [transcript, setTranscript] = useState('');
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const [draftStartDate, setDraftStartDate] = useState('');
  const [draftStartTime, setDraftStartTime] = useState('');
  const [draftStartTimeInvalid, setDraftStartTimeInvalid] = useState(false);
  const [draftDueTimeInvalid, setDraftDueTimeInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [asrReady, setAsrReady] = useState<boolean | null>(null);

  useEffect(() => {
    if (!open) return;
    setStage('capture');
    setTranscript('');
    setDraft(null);
    setError(null);
    setNotice(null);
    recorder.reset();
    api.voice
      .status()
      .then((s) => setAsrReady(s.asr.configured))
      .catch(() => setAsrReady(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 录音完成 → 自动转写
  useEffect(() => {
    if (stage !== 'capture' || recorder.state !== 'done' || !recorder.wavBlob) return;
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        const { blobToBase64 } = await import('../hooks/useRecorder');
        const base64 = await blobToBase64(recorder.wavBlob!);
        const res = await api.voice.transcribe(base64, 'wav');
        setTranscript(res.text);
        setStage('transcript');
        if (!res.text) setNotice('没有识别到语音内容，可以手动输入文字后继续');
      } catch (err) {
        setError(err instanceof ApiError ? err.message : '语音识别失败');
        setNotice('可以直接手动输入文字，或稍后重试');
        setStage('transcript');
      } finally {
        setBusy(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, recorder.state, recorder.wavBlob]);

  if (!open) return null;

  async function parseTranscript() {
    if (!transcript.trim()) {
      setError('请先输入或说出要记录的内容');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.voice.parse(transcript.trim());
      setDraft(res.draft);
      const start = splitLocal(res.draft.start_at);
      setDraftStartDate(start.date);
      setDraftStartTime(start.time);
      setDraftStartTimeInvalid(false);
      setDraftDueTimeInvalid(false);
      setStage('draft');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '解析失败');
    } finally {
      setBusy(false);
    }
  }

  async function confirmCreate() {
    if (!draft) return;
    setError(null);

    const isEvent = draft.kind === 'event';
    if (!draft.title.trim()) {
      setError('标题不能为空');
      return;
    }
    if ((isEvent && draftStartTimeInvalid) || (!isEvent && draftDueTimeInvalid)) {
      setError('请把时间的小时和分钟填写完整，并确认数值有效');
      return;
    }
    // 含糊时间不擅自补全：必须由用户给出具体时间
    if (isEvent && (!draftStartDate || !draftStartTime)) {
      setError('请补充开始时间的日期和时刻后再创建');
      return;
    }
    if (!isEvent && draft.reminder_enabled && draft.reminder_offsets.length > 0 && !draft.due_time) {
      setError('待办要精确提醒必须补充具体时刻');
      return;
    }

    setBusy(true);
    try {
      // 关闭提醒时不下发提前量：界面上关闭就是关闭，不生成任何通知任务
      const reminderOffsets = draft.reminder_enabled ? draft.reminder_offsets : [];
      if (isEvent) {
        const startInstant = new Date(`${draftStartDate}T${draftStartTime}`);
        if (Number.isNaN(startInstant.getTime())) {
          setError('开始时间不完整，请检查日期和时刻');
          return;
        }
        await api.events.create({
          title: draft.title,
          startAt: startInstant.toISOString(),
          endAt: draft.end_at ? new Date(draft.end_at).toISOString() : null,
          location: draft.location,
          note: draft.note,
          reminderEnabled: draft.reminder_enabled,
          reminderOffsets,
          source: 'voice',
        });
      } else {
        await api.tasks.create({
          title: draft.title,
          dueDate: draft.due_date,
          dueTime: draft.due_time,
          note: draft.note,
          reminderEnabled: draft.reminder_enabled,
          reminderOffsets,
          source: 'voice',
        });
      }
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建失败');
    } finally {
      setBusy(false);
    }
  }

  const recording = recorder.state === 'recording';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4">
      <div
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-pop sm:rounded-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="语音录入"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">语音录入</h2>
          <button type="button" onClick={onClose} className="btn-ghost !px-3 !py-1.5 text-xs">
            关闭
          </button>
        </div>

        {asrReady === false ? (
          <div className="mb-4">
            <Alert tone="warn">语音识别当前不可用，你可以直接在下方输入文字，效果相同。</Alert>
          </div>
        ) : null}

        {/* ── 阶段 1：录音 ── */}
        {stage === 'capture' ? (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-3 py-4">
              <button
                type="button"
                onClick={() => (recording ? recorder.stop() : void recorder.start())}
                disabled={busy || recorder.state === 'processing' || recorder.state === 'requesting'}
                className={`flex h-20 w-20 items-center justify-center rounded-3xl text-white transition-transform active:scale-95 disabled:opacity-60 ${
                  recording ? 'bg-red-500' : 'bg-brand'
                }`}
                aria-label={recording ? '停止录音' : '开始录音'}
              >
                {recorder.state === 'processing' ? <Spinner className="h-7 w-7" /> : <IconMic width={30} height={30} />}
              </button>

              <p className="text-sm font-medium">
                {recorder.state === 'requesting'
                  ? '正在请求麦克风权限…'
                  : recorder.state === 'processing'
                    ? '正在转换音频…'
                    : recording
                      ? `录音中 ${recorder.seconds}s / ${recorder.maxSeconds}s`
                      : '点击开始录音'}
              </p>
              {recording ? (
                <button type="button" className="btn-ghost text-xs" onClick={recorder.stop}>
                  停止并识别
                </button>
              ) : null}
            </div>

            <div className="border-t border-line pt-3">
              <p className="mb-2 text-xs text-muted">或者直接输入文字（效果相同，可随时改用）</p>
              <textarea
                className="input min-h-[4rem] resize-y"
                placeholder="例如：下周三下午三点在科研楼参加课题组会议，提前一个小时和十分钟微信提醒"
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
              />
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy || !transcript.trim()}
                  onClick={() => void parseTranscript()}
                >
                  {busy ? <Spinner /> : null}
                  解析为草稿
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* ── 阶段 2：转写文字可修改后重新解析 ── */}
        {stage === 'transcript' ? (
          <div className="space-y-3">
            <div>
              <label className="label" htmlFor="vc-transcript">
                识别结果（可修改后重新解析）
              </label>
              <textarea
                id="vc-transcript"
                className="input min-h-[6rem] resize-y"
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                autoFocus
              />
            </div>
            <div className="flex justify-between gap-2">
              <button type="button" className="btn-ghost" onClick={() => setStage('capture')}>
                重新录制
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy || !transcript.trim()}
                onClick={() => void parseTranscript()}
              >
                {busy ? <Spinner /> : null}
                解析为草稿
              </button>
            </div>
          </div>
        ) : null}

        {/* ── 阶段 3：草稿预览（确认前不落库）── */}
        {stage === 'draft' && draft ? (
          <div className="space-y-3.5">
            <Alert tone="info">
              这是预览草稿，**尚未保存**。确认无误后点「确认创建」才会写入日程并安排提醒。
            </Alert>

            {draft.ambiguities.length > 0 ? (
              <Alert tone="warn">
                <p className="font-medium">需要你补充</p>
                <ul className="mt-1 list-disc pl-4">
                  {draft.ambiguities.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}

            <div>
              <label className="label" htmlFor="vd-title">
                标题
              </label>
              <input
                id="vd-title"
                className="input"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </div>

            <div>
              <span className="label">类型</span>
              <div className="flex gap-1 rounded-xl border border-line p-1">
                {(['event', 'task'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setDraft({ ...draft, kind: k })}
                    className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                      draft.kind === k ? 'bg-brand/10 text-brand' : 'text-muted hover:text-ink'
                    }`}
                  >
                    {k === 'event' ? '事件' : '待办'}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 px-1 text-xs text-muted">{KIND_HINT}</p>
            </div>

            {draft.kind === 'event' ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="vd-start-date">
                    开始日期
                  </label>
                  <input
                    id="vd-start-date"
                    type="date"
                    className="input"
                    value={draftStartDate}
                    onChange={(e) => setDraftStartDate(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="vd-start-time">
                    开始时间（24 小时制）
                  </label>
                  <TimeInput
                    id="vd-start-time"
                    ariaLabel="开始时间"
                    value={draftStartTime}
                    onChange={setDraftStartTime}
                    onInvalidChange={setDraftStartTimeInvalid}
                  />
                </div>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="vd-date">
                    截止日期
                  </label>
                  <input
                    id="vd-date"
                    type="date"
                    className="input"
                    value={draft.due_date ?? ''}
                    onChange={(e) => setDraft({ ...draft, due_date: e.target.value || null })}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="vd-time">
                    具体时刻（24 小时制）
                  </label>
                  <TimeInput
                    id="vd-time"
                    ariaLabel="具体时刻"
                    value={draft.due_time ?? ''}
                    onChange={(v) => setDraft({ ...draft, due_time: v || null })}
                    onInvalidChange={setDraftDueTimeInvalid}
                  />
                </div>
              </div>
            )}

            <div>
              <label className="label" htmlFor="vd-location">
                地点
              </label>
              <input
                id="vd-location"
                className="input"
                value={draft.location ?? ''}
                onChange={(e) => setDraft({ ...draft, location: e.target.value || null })}
              />
            </div>

            <div className="rounded-xl border border-line p-3.5">
              <label className="flex cursor-pointer items-center justify-between gap-3">
                <span className="text-sm font-medium">微信提醒</span>
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[#6366f1]"
                  checked={draft.reminder_enabled}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      reminder_enabled: e.target.checked,
                      reminder_offsets: e.target.checked && draft.reminder_offsets.length === 0 ? [60, 10] : draft.reminder_offsets,
                    })
                  }
                />
              </label>
              {draft.reminder_enabled ? (
                <div className="mt-3 space-y-2">
                  <p className="text-xs text-muted">提前量（可多选，识别结果已预选）</p>
                  <OffsetChips
                    selected={draft.reminder_offsets}
                    onToggle={(minutes) =>
                      setDraft({
                        ...draft,
                        reminder_offsets: draft.reminder_offsets.includes(minutes)
                          ? draft.reminder_offsets.filter((m) => m !== minutes)
                          : [...draft.reminder_offsets, minutes].sort((a, b) => b - a),
                      })
                    }
                  />
                  {draft.reminder_offsets.length === 0 ? (
                    <p className="text-xs text-subscription">未选择提前量，创建后不会产生任何提醒</p>
                  ) : null}
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted">原文未明确要求提醒，默认关闭；关闭后不会生成任何通知</p>
              )}
            </div>

            {error ? <Alert>{error}</Alert> : null}

            <div className="flex justify-between gap-2 pt-1">
              <button type="button" className="btn-ghost" onClick={() => setStage('transcript')}>
                返回修改文字
              </button>
              <button type="button" className="btn-primary" disabled={busy} onClick={() => void confirmCreate()}>
                {busy ? <Spinner /> : null}
                确认创建
              </button>
            </div>
          </div>
        ) : null}

        {notice ? (
          <div className="mt-3">
            <Alert tone="warn">{notice}</Alert>
          </div>
        ) : null}
        {stage !== 'draft' && error ? (
          <div className="mt-3">
            <Alert>{error}</Alert>
          </div>
        ) : null}
        {recorder.error ? (
          <div className="mt-3">
            <Alert>{recorder.error}</Alert>
          </div>
        ) : null}
      </div>
    </div>
  );
}

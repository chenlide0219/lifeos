import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { Alert, Spinner } from './ui';

type TestState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'queued'; jobId: string; status: string; attempts: number; lastError: string | null }
  | { kind: 'blocked'; message: string }
  | { kind: 'error'; message: string };

const TERMINAL = new Set(['sent', 'failed', 'cancelled', 'skipped', 'missed']);

const STATUS_TEXT: Record<string, string> = {
  pending: '已排队，等待 Worker 发送…',
  sending: '正在发送…',
  sent: '已发送（微信侧已接受）',
  failed: '发送失败',
  cancelled: '已取消',
  skipped: '已跳过',
  missed: '已错过',
};

/**
 * 发送测试消息（PRD FR-07）。
 *
 * 诚实性要求：
 *   - 未配置通道时按钮会明确失败并说明原因，**不排队、不假装已发送**；
 *   - 即使显示"已发送"，也只代表**微信侧已接受**，不代表手机一定显示；
 *     因此界面上明确写出这一点，不夸大结论。
 */
export function TestSendPanel() {
  const [state, setState] = useState<TestState>({ kind: 'idle' });
  const timerRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const poll = useCallback(
    (jobId: string) => {
      stopPolling();
      // 最多轮询 30 秒；Worker 默认 20 秒轮询一次，给足一个周期
      const deadline = Date.now() + 30_000;
      timerRef.current = window.setInterval(() => {
        void (async () => {
          try {
            const res = await api.testNotificationStatus(jobId);
            setState({
              kind: 'queued',
              jobId,
              status: res.job.status,
              attempts: res.job.attempts,
              lastError: res.job.lastError,
            });
            if (TERMINAL.has(res.job.status) || Date.now() > deadline) stopPolling();
          } catch {
            stopPolling();
          }
        })();
      }, 2000);
    },
    [stopPolling],
  );

  async function send() {
    stopPolling();
    setState({ kind: 'sending' });
    try {
      const res = await api.sendTestNotification();
      setState({
        kind: 'queued',
        jobId: res.job.id,
        status: res.job.status,
        attempts: 0,
        lastError: null,
      });
      poll(res.job.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setState({ kind: 'blocked', message: err.message });
        return;
      }
      setState({ kind: 'error', message: err instanceof ApiError ? err.message : '发送失败' });
    }
  }

  const busy = state.kind === 'sending';

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => void send()}>
          {busy ? <Spinner /> : null}
          发送测试消息
        </button>
        <p className="text-xs text-muted">用于验证微信通道是否真的可用</p>
      </div>

      {state.kind === 'blocked' ? (
        <Alert tone="warn">
          <p className="font-medium">测试消息未发送</p>
          <p className="mt-1">{state.message}</p>
          <p className="mt-1 text-xs">配置好发送凭据后再试；在此之前提醒任务不会被消费。</p>
        </Alert>
      ) : null}

      {state.kind === 'error' ? <Alert>{state.message}</Alert> : null}

      {state.kind === 'queued' ? (
        <div className="rounded-xl border border-line px-3.5 py-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              {TERMINAL.has(state.status) ? null : <Spinner className="text-muted" />}
              {STATUS_TEXT[state.status] ?? state.status}
            </span>
            <span className="text-xs text-muted">尝试 {state.attempts} 次</span>
          </div>

          {state.status === 'sent' ? (
            <p className="mt-2 text-xs text-muted">
              注意：这只表示微信侧已接受，**不代表手机一定已显示**。请以手机上实际收到为准。
            </p>
          ) : null}

          {state.lastError ? (
            <p className="mt-2 break-words rounded-lg bg-red-500/10 px-2.5 py-2 font-mono text-[11px] text-red-600 dark:text-red-400">
              {state.lastError}
            </p>
          ) : null}

          {!TERMINAL.has(state.status) && state.attempts === 0 ? (
            <p className="mt-2 text-xs text-muted">Worker 每隔约 20 秒轮询一次，请稍候。</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { ApiError, requestRaw } from '../api';
import { Alert, Card } from './ui';

/**
 * V1.1 微信助手状态（只读）。
 *
 * 存在的理由：真机排查时不必登录服务器查库。发了一句话之后，
 * 这里能直接看出"消息有没有进来""草稿建了没有""回复发出去了没有"。
 * 不含任何凭据，也不展示私有状态。
 */
type DraftView = {
  id: string;
  status: string;
  shortCode: string | null;
  version: number;
  title: string | null;
  kind: string | null;
  missingFields: string[];
  expiresAt: string;
  updatedAt: string;
};

type OperationView = {
  id: string;
  status: string;
  title: string | null;
  kind: string | null;
  resultSubjectType: string | null;
  resultSubjectId: string | null;
  updatedAt: string;
};

type ReplyView = {
  id: string;
  replyType: string;
  status: string;
  failureKind: string | null;
  operationId: string | null;
  sentAt: string | null;
  createdAt: string;
  lastError: string | null;
};

type AssistantState = {
  inboundEnabled: boolean;
  modelCallsEnabled: boolean;
  draft: DraftView | null;
  recent: OperationView[];
  recentReplies: ReplyView[];
  inboundCounts: Record<string, number>;
  outboxCounts: Record<string, number>;
  listenerAt: string | null;
  listenerError: string | null;
};

const DRAFT_STATUS: Record<string, string> = {
  awaiting_fields: '缺字段，等待补充',
  pending_confirm: '待确认（可回复确认短码）',
  committing: '提交中',
};

const OP_STATUS: Record<string, string> = {
  committed: '已保存',
  cancelled: '已取消',
  expired: '已过期（未保存）',
  invalidated: '已因换绑失效',
  awaiting_fields: '未完成',
  pending_confirm: '待确认',
};

const REPLY_STATUS: Record<string, string> = {
  pending: '待发送',
  sending: '发送中',
  sent: '已发送',
  failed: '发送失败',
  suppressed: '已作废（过时或不适用）',
  cancelled: '已取消',
};

function counts(obj: Record<string, number>): string {
  const entries = Object.entries(obj ?? {}).filter(([, n]) => n > 0);
  if (entries.length === 0) return '无';
  return entries.map(([k, n]) => `${k} ${n}`).join(' · ');
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

export function AssistantStatus() {
  const [state, setState] = useState<AssistantState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const data = await requestRaw<AssistantState>('/wechat/assistant');
        if (!stopped) setState(data);
      } catch (err) {
        if (!stopped) setError(err instanceof ApiError ? err.message : '无法读取助手状态');
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <Card title="微信助手" subtitle="一句话创建日程/待办，或查询安排（V1.1）">
      {!state ? (
        <p className="text-sm text-muted">读取中…</p>
      ) : (
        <div className="space-y-3 text-sm">
          {!state.inboundEnabled ? (
            <Alert tone="warn">
              业务输入已关闭：微信发消息不会创建或查询事项，但**主动提醒仍会正常发送**。
            </Alert>
          ) : null}
          {!state.modelCallsEnabled ? (
            <Alert tone="warn">
              模型调用已关闭：自然语言不可用，仅 /today、确认短码等确定性命令可用。生产环境不应处于此状态。
            </Alert>
          ) : null}
          {state.listenerError ? <Alert tone="warn">{state.listenerError}</Alert> : null}

          <p className="text-muted">
            接收心跳：{fmt(state.listenerAt)}　入站：{counts(state.inboundCounts)}　回复：{counts(state.outboxCounts)}
          </p>

          <div className="rounded-xl border border-line p-3">
            <p className="font-medium">当前草稿</p>
            {state.draft ? (
              <div className="mt-1 space-y-1">
                <p>
                  {state.draft.title || '（未命名）'} ·{' '}
                  {state.draft.kind === 'event' ? '日程' : state.draft.kind === 'task' ? '待办' : '未知类型'}
                </p>
                <p>
                  状态：<strong>{DRAFT_STATUS[state.draft.status] ?? state.draft.status}</strong>
                  {state.draft.shortCode ? (
                    <>
                      {' '}
                      · 确认短码 <code className="rounded bg-surface px-1">{state.draft.shortCode}</code>
                    </>
                  ) : null}
                  {` · 版本 ${state.draft.version}`}
                </p>
                {state.draft.missingFields.length > 0 ? (
                  <p className="text-amber-700">
                    仍缺：{state.draft.missingFields.map((f) => (f === 'title' ? '名称' : f === 'start_at' ? '开始时间' : f)).join('、')}
                  </p>
                ) : null}
                <p className="text-muted">到期：{fmt(state.draft.expiresAt)}　更新：{fmt(state.draft.updatedAt)}</p>
              </div>
            ) : (
              <p className="mt-1 text-muted">没有未保存的草稿。</p>
            )}
          </div>

          <div className="rounded-xl border border-line p-3">
            <p className="font-medium">最近操作</p>
            {state.recent.length === 0 ? (
              <p className="mt-1 text-muted">还没有任何操作记录。</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {state.recent.map((row) => (
                  <li key={row.id}>
                    · {fmt(row.updatedAt)}　{row.title || '（未命名）'}　
                    <strong>{OP_STATUS[row.status] ?? row.status}</strong>
                    {row.resultSubjectId ? `　→ ${row.resultSubjectType === 'event' ? '事件' : '待办'}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border border-line p-3">
            <p className="font-medium">最近回复投递</p>
            {state.recentReplies.length === 0 ? (
              <p className="mt-1 text-muted">还没有回复记录。</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {state.recentReplies.map((row) => (
                  <li key={row.id}>
                    · {fmt(row.createdAt)}　{row.replyType}　
                    <strong>{REPLY_STATUS[row.status] ?? row.status}</strong>
                    {row.failureKind ? `（${row.failureKind}）` : ''}
                    {row.sentAt ? `　已发 ${fmt(row.sentAt)}` : ''}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-muted">
              「结果未知」的回复按策略**不会自动重发**，需在手机上确认是否已收到。
            </p>
          </div>
        </div>
      )}
      {error ? (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      ) : null}
    </Card>
  );
}

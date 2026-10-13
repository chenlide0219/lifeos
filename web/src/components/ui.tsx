import type { ReactNode } from 'react';

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        {description ? <p className="page-description">{description}</p> : null}
      </div>
      {action ? <div className="page-actions shrink-0">{action}</div> : null}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl bg-canvas/60 px-6 py-10 text-center">
      {icon ? <div className="mb-4 rounded-xl border border-line bg-surface p-3 text-brand">{icon}</div> : null}
      <p className="text-sm font-medium text-ink">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Card({
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card p-4 sm:p-6 ${className}`}>
      {title ? (
        <header className="section-heading">
          <div>
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-xs text-muted">{subtitle}</p> : null}
          </div>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'error' | 'idle' }) {
  const color =
    tone === 'ok'
      ? 'bg-task'
      : tone === 'warn'
        ? 'bg-subscription'
        : tone === 'error'
          ? 'bg-red-500'
          : 'bg-muted';
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

/** 类型标签：颜色 + 文字双通道，不只依赖颜色识别（PRD 3.2） */
export function TypeBadge({ type }: { type: 'event' | 'task' | 'subscription' }) {
  const map = {
    event: { label: '事件', cls: 'bg-event-soft text-event' },
    task: { label: '待办', cls: 'bg-task-soft text-task' },
    subscription: { label: '订阅', cls: 'bg-subscription-soft text-subscription' },
  } as const;
  const { label, cls } = map[type];
  return <span className={`chip ${cls}`}>{label}</span>;
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg role="status" aria-label="加载中" className={`animate-spin ${className}`} width="16" height="16" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Alert({ tone = 'error', children }: { tone?: 'error' | 'warn' | 'info'; children: ReactNode }) {
  const cls =
    tone === 'error'
      ? 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400'
      : tone === 'warn'
        ? 'border-subscription/30 bg-subscription/10 text-subscription'
        : 'border-line bg-canvas text-muted';
  return <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-xl border px-3.5 py-2.5 text-sm ${cls}`}>{children}</div>;
}

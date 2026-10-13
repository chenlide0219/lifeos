import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type TaskDto, type TaskView } from '../api';
import { IconPlus, IconTodo } from '../components/Icons';
import { QuickAddDialog } from '../components/QuickAdd';
import { Alert, Card, EmptyState, PageHeader, Spinner } from '../components/ui';

const TABS: { key: TaskView; label: string }[] = [
  { key: 'inbox', label: '收件箱' },
  { key: 'today', label: '今天' },
  { key: 'upcoming', label: '计划中' },
  { key: 'done', label: '已完成' },
];

const EMPTY_COPY: Record<TaskView, { title: string; description: string }> = {
  inbox: { title: '收件箱是空的', description: '还没有待办。点「新增」用文字创建一条。' },
  today: { title: '今天没有到期的待办', description: '今天到期或已逾期的待办会显示在这里。' },
  upcoming: { title: '没有计划中的待办', description: '有未来截止日期的待办会显示在这里。' },
  done: { title: '还没有完成的待办', description: '勾选完成后，记录会归档到这里。' },
};

function formatDue(task: TaskDto): string | null {
  if (!task.dueDate) return null;
  const time = task.dueTime ? task.dueTime.slice(0, 5) : null;
  return time ? `${task.dueDate} ${time}` : `${task.dueDate}（全天）`;
}

function isOverdue(task: TaskDto, today: string): boolean {
  return task.status === 'todo' && Boolean(task.dueDate) && task.dueDate! < today;
}

export function TodoPage() {
  const [tab, setTab] = useState<TaskView>('today');
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [counts, setCounts] = useState<Record<TaskView, number>>({ inbox: 0, today: 0, upcoming: 0, done: 0 });
  const [today, setToday] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TaskDto | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (view: TaskView) => {
    setLoading(true);
    setError(null);
    try {
      const [list, countRes] = await Promise.all([api.tasks.list(view), api.tasks.counts()]);
      setTasks(list.tasks);
      setToday(list.today);
      setCounts(countRes.counts);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '读取待办失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(tab);
  }, [tab, load]);

  async function toggleComplete(task: TaskDto) {
    setBusyId(task.id);
    setError(null);
    try {
      if (task.status === 'done') await api.tasks.reopen(task.id);
      else await api.tasks.complete(task.id);
      await load(tab);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '操作失败');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(task: TaskDto) {
    const confirmed = window.confirm(`删除待办「${task.title}」？该操作不可恢复，未发送的提醒会一并取消。`);
    if (!confirmed) return;

    setBusyId(task.id);
    setError(null);
    try {
      await api.tasks.remove(task.id);
      await load(tab);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '删除失败');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader
        title="待办"
        description="清空脑中的杂事，把注意力留给眼前的行动。"
        action={
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <IconPlus width={18} height={18} />
            新增
          </button>
        }
      />

      <div className="filter-tabs">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            aria-pressed={tab === key}
            className={`flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              tab === key ? 'bg-brand/10 text-brand' : 'text-muted hover:text-ink'
            }`}
          >
            {label}
            <span className="ml-1.5 text-xs opacity-70">{counts[key] ?? 0}</span>
          </button>
        ))}
      </div>

      {error ? (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      ) : null}

      <Card title={TABS.find((item) => item.key === tab)?.label} subtitle={`${tasks.length} 项待办`}>
        {loading && tasks.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
            <Spinner /> 读取中…
          </div>
        ) : tasks.length === 0 ? (
          <EmptyState icon={<IconTodo width={28} height={28} />} title={EMPTY_COPY[tab].title} description={EMPTY_COPY[tab].description} />
        ) : (
          <ul className="record-list divide-y divide-line">
            {tasks.map((task) => (
              <li key={task.id} className="mobile-record flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <input
                  type="checkbox"
                  className="mt-1 h-6 w-6 shrink-0 accent-brand"
                  checked={task.status === 'done'}
                  disabled={busyId === task.id}
                  onChange={() => void toggleComplete(task)}
                  aria-label={task.status === 'done' ? '标记为未完成' : '标记为完成'}
                />

                <div className="min-w-0 flex-1">
                  <p className={`text-sm ${task.status === 'done' ? 'text-muted line-through' : 'font-medium'}`}>
                    {task.title}
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span className="chip bg-task-soft text-task">待办</span>
                    {task.dueDate ? (
                      <span className={isOverdue(task, today) ? 'font-medium text-red-500' : ''}>
                        {formatDue(task)}
                        {isOverdue(task, today) ? ' · 已逾期' : ''}
                      </span>
                    ) : (
                      <span>无截止日期</span>
                    )}
                    {task.note ? <span className="truncate">· {task.note}</span> : null}
                  </div>
                </div>

                <div className="row-actions">
                  <button
                    type="button"
                    className="rounded-lg px-2 py-1 text-xs text-muted transition-colors hover:bg-canvas hover:text-ink"
                    onClick={() => {
                      setEditing(task);
                      setDialogOpen(true);
                    }}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="rounded-lg px-2 py-1 text-xs text-muted transition-colors hover:bg-canvas hover:text-red-500"
                    disabled={busyId === task.id}
                    onClick={() => void remove(task)}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <QuickAddDialog
        open={dialogOpen}
        mode="task"
        task={editing}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSaved={() => void load(tab)}
      />
    </>
  );
}

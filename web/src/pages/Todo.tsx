import { useState } from 'react';
import { IconTodo } from '../components/Icons';
import { Card, EmptyState, PageHeader } from '../components/ui';

const TABS = [
  { key: 'inbox', label: '收件箱' },
  { key: 'today', label: '今天' },
  { key: 'upcoming', label: '计划中' },
  { key: 'done', label: '已完成' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

const EMPTY_COPY: Record<TabKey, { title: string; description: string }> = {
  inbox: { title: '收件箱是空的', description: '还没有待办。阶段 2 接入后，可直接新增或语音创建。' },
  today: { title: '今天没有到期的待办', description: '到期日或时刻落在今天的待办会显示在这里。' },
  upcoming: { title: '没有计划中的待办', description: '有截止日期但不在今天的待办会显示在这里。' },
  done: { title: '还没有完成的待办', description: '勾选完成后，记录会归档到这里。' },
};

export function TodoPage() {
  const [tab, setTab] = useState<TabKey>('inbox');

  return (
    <>
      <PageHeader title="待办" description="收件箱、今天、计划中、已完成" />

      <div className="mb-4 flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              tab === key ? 'bg-brand/10 text-brand' : 'text-muted hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <Card>
        <EmptyState
          icon={<IconTodo width={28} height={28} />}
          title={EMPTY_COPY[tab].title}
          description={EMPTY_COPY[tab].description}
        />
      </Card>
    </>
  );
}

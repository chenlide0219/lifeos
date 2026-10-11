import { IconSubscription } from '../components/Icons';
import { Card, EmptyState, PageHeader } from '../components/ui';

export function SubscriptionsPage() {
  return (
    <>
      <PageHeader
        title="订阅"
        description="维护订阅档案、计费周期与到期日期，并独立配置每项提醒"
      />

      <Card>
        <EmptyState
          icon={<IconSubscription width={28} height={28} />}
          title="还没有订阅记录"
          description="阶段 4 接入后，可在此建立订阅档案；系统会按计费规则生成未来 12 个月的预计账单，并显示在日历中。"
        />
      </Card>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-line bg-surface px-4 py-3.5">
          <p className="text-xs font-medium text-muted">预计月均支出</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight">—</p>
          <p className="mt-1 text-xs text-muted">按当前周期折算，与实付口径分开统计</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface px-4 py-3.5">
          <p className="text-xs font-medium text-muted">当月实付</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight">—</p>
          <p className="mt-1 text-xs text-muted">仅统计已确认的实际付款</p>
        </div>
      </div>
    </>
  );
}

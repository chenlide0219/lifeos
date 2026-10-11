import { IconAnalytics } from '../components/Icons';
import { Card, EmptyState, PageHeader } from '../components/ui';

export function AnalyticsPage() {
  return (
    <>
      <PageHeader title="统计" description="预计支出与实际付款分开统计，口径明确标注" />

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="预计订阅支出" subtitle="口径：按活跃订阅当前计费规则折算的预计月均">
          <EmptyState
            icon={<IconAnalytics width={28} height={28} />}
            title="暂无数据"
            description="接入订阅档案后，这里显示未来 12 个月滚动预计账单与月均折算。"
          />
        </Card>

        <Card title="实际付款净支出" subtitle="口径：指定期间内已确认付款，扣除退款">
          <EmptyState
            icon={<IconAnalytics width={28} height={28} />}
            title="暂无数据"
            description="接入付款记录或完成 CSV 导入后，这里显示实际净支出与时间趋势。"
          />
        </Card>
      </div>

      <div className="mt-4 rounded-2xl border border-subscription/30 bg-subscription/5 px-4 py-3.5 text-sm text-muted">
        <p className="font-medium text-subscription">口径说明</p>
        <p className="mt-1">
          预计账单永不自动视为已付款；人民币汇总使用带日期来源的汇率快照，汇率不可用时以手动汇率显示并标注“估算”，
          不伪装为精确实付人民币。
        </p>
      </div>
    </>
  );
}

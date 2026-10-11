import { useEffect, useState } from 'react';
import { api, type SystemStatusResponse } from '../api';
import { IconBell, IconCalendar, IconSparkle, IconTodo } from '../components/Icons';
import { Card, EmptyState, PageHeader, Spinner, StatusDot } from '../components/ui';
import { useAuth } from '../hooks/useAuth';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

export function DashboardPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<SystemStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .status()
      .then((res) => {
        if (!cancelled) setStatus(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '状态获取失败');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const now = new Date();
  const dateLabel = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${WEEKDAYS[now.getDay()]}`;

  return (
    <>
      <PageHeader title={`${greeting()}，${user?.username ?? ''}`} description={dateLabel} />

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="今日待办" subtitle="到期的待办会出现在这里">
          <EmptyState
            icon={<IconTodo width={28} height={28} />}
            title="今天没有待办"
            description="阶段 2 接入待办模块后，这里会显示今天到期的事项。"
          />
        </Card>

        <Card title="未来 7 天" subtitle="事件、待办与订阅续费统一视图">
          <EmptyState
            icon={<IconCalendar width={28} height={28} />}
            title="暂无安排"
            description="阶段 2 接入日历聚合后，这里会显示未来一周的日程。"
          />
        </Card>

        <Card title="即将到期订阅" subtitle="按当前计费周期推算">
          <EmptyState
            icon={<IconBell width={28} height={28} />}
            title="暂无订阅"
            description="阶段 4 接入订阅模块后，这里会显示临近扣费或到期的服务。"
          />
        </Card>

        <Card title="系统状态" subtitle="服务端实时数据">
          {error ? (
            <p className="text-sm text-red-500">{error}</p>
          ) : !status ? (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Spinner /> 读取中…
            </div>
          ) : (
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-muted">数据库</dt>
                <dd className="flex items-center gap-2 font-medium">
                  <StatusDot tone={status.db === 'up' ? 'ok' : 'error'} />
                  {status.db === 'up' ? '正常' : '不可用'}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted">时区</dt>
                <dd className="font-medium">{status.timezone}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted">语音识别（MiMo）</dt>
                <dd className="flex items-center gap-2 font-medium">
                  <StatusDot tone={status.ai.asr.configured ? 'ok' : 'warn'} />
                  {status.ai.asr.configured ? '已配置' : '未配置'}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted">事项解析（DeepSeek）</dt>
                <dd className="flex items-center gap-2 font-medium">
                  <StatusDot tone={status.ai.llm.configured ? 'ok' : 'warn'} />
                  {status.ai.llm.configured ? '已配置' : '未配置'}
                </dd>
              </div>
              {status.notifications.map((provider) => (
                <div key={provider.channel} className="flex items-center justify-between">
                  <dt className="text-muted">{provider.name}</dt>
                  <dd className="flex items-center gap-2 font-medium">
                    <StatusDot tone={provider.configured ? 'ok' : 'warn'} />
                    {provider.configured ? '已配置' : '未配置'}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Card>
      </div>

      <div className="mt-4 flex items-start gap-3 rounded-2xl border border-line bg-surface px-4 py-3.5">
        <IconSparkle className="mt-0.5 shrink-0 text-brand" />
        <p className="text-sm text-muted">
          阶段 1 已完成：基础设施、数据库迁移、管理员登录与权限、服务守护。
          日历聚合、待办、订阅财务、语音录入与微信提醒将在后续阶段依次接入。
        </p>
      </div>
    </>
  );
}

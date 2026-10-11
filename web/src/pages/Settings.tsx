import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api, type SystemStatusResponse } from '../api';
import { IconLogout } from '../components/Icons';
import { NotificationLog } from '../components/NotificationLog';
import { Alert, Card, PageHeader, Spinner, StatusDot } from '../components/ui';
import { useAuth } from '../hooks/useAuth';
import { useTheme, type ThemeMode } from '../hooks/useTheme';

const THEME_OPTIONS: { key: ThemeMode; label: string }[] = [
  { key: 'light', label: '浅色' },
  { key: 'dark', label: '深色' },
  { key: 'system', label: '跟随系统' },
];

export function SettingsPage() {
  const { user, logout } = useAuth();
  const { mode, setMode } = useTheme();
  const [status, setStatus] = useState<SystemStatusResponse | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwNotice, setPwNotice] = useState<string | null>(null);
  const [pwSubmitting, setPwSubmitting] = useState(false);

  useEffect(() => {
    api
      .status()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  async function handlePasswordChange(event: FormEvent) {
    event.preventDefault();
    setPwError(null);
    setPwNotice(null);

    if (newPassword !== confirmPassword) {
      setPwError('两次输入的新密码不一致');
      return;
    }

    setPwSubmitting(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setPwNotice('密码已更新，其他设备上的登录已失效');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setPwError(err instanceof ApiError ? err.message : '修改失败，请稍后重试');
    } finally {
      setPwSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader title="设置" description="账户安全、外观、模型接口与通知通道状态" />

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="账户" subtitle={user?.username}>
          <form onSubmit={handlePasswordChange} className="space-y-3">
            <div>
              <label className="label" htmlFor="current-password">
                当前密码
              </label>
              <input
                id="current-password"
                type="password"
                className="input"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="new-password">
                新密码
              </label>
              <input
                id="new-password"
                type="password"
                className="input"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                minLength={12}
                required
              />
              <p className="mt-1 text-xs text-muted">至少 12 位，且包含大写、小写、数字、符号中的三类</p>
            </div>
            <div>
              <label className="label" htmlFor="confirm-password">
                确认新密码
              </label>
              <input
                id="confirm-password"
                type="password"
                className="input"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
            </div>

            {pwError ? <Alert>{pwError}</Alert> : null}
            {pwNotice ? <Alert tone="warn">{pwNotice}</Alert> : null}

            <div className="flex items-center gap-2 pt-1">
              <button type="submit" className="btn-primary" disabled={pwSubmitting}>
                {pwSubmitting ? <Spinner /> : null}
                修改密码
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => void logout()}
                title="退出当前设备"
              >
                <IconLogout width={18} height={18} />
                退出登录
              </button>
            </div>
          </form>
        </Card>

        <div className="space-y-4">
          <Card title="外观" subtitle="主题偏好保存在本机浏览器">
            <div className="flex gap-2">
              {THEME_OPTIONS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setMode(key)}
                  aria-pressed={mode === key}
                  className={`flex-1 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                    mode === key
                      ? 'border-brand/30 bg-brand/10 text-brand'
                      : 'border-line text-muted hover:text-ink'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </Card>

          <Card title="服务状态" subtitle="密钥仅保存在服务端，此处只显示配置与否">
            {!status ? (
              <div className="flex items-center gap-2 text-sm text-muted">
                <Spinner /> 读取中…
              </div>
            ) : (
              <dl className="space-y-3 text-sm">
                <Row label="数据库" value={status.db === 'up' ? '正常' : '不可用'} tone={status.db === 'up' ? 'ok' : 'error'} />
                <Row label="时区" value={status.timezone} />
                <Row
                  label="MiMo 语音识别"
                  value={status.ai.asr.configured ? `已配置（${status.ai.asr.model}）` : '未配置'}
                  tone={status.ai.asr.configured ? 'ok' : 'warn'}
                />
                <Row
                  label="DeepSeek 事项解析"
                  value={status.ai.llm.configured ? `已配置（${status.ai.llm.model}）` : '未配置'}
                  tone={status.ai.llm.configured ? 'ok' : 'warn'}
                />
                {status.notifications.map((provider) => (
                  <div key={provider.channel} className="space-y-1.5">
                    <Row
                      label={`${provider.name} · 凭据`}
                      value={provider.configured ? '已配置' : '未配置'}
                      tone={provider.configured ? 'ok' : 'warn'}
                    />
                    <Row
                      label={`${provider.name} · 链路`}
                      value={
                        provider.reachable === null ? '未探测' : provider.reachable ? '可达' : '不可达'
                      }
                      tone={provider.reachable === null ? 'idle' : provider.reachable ? 'ok' : 'error'}
                    />
                    <p className="text-xs leading-relaxed text-muted">{provider.detail}</p>
                  </div>
                ))}
                <Row label="服务版本" value={status.version} />
              </dl>
            )}
          </Card>
        </div>
      </div>

      <Card
        title="通知记录"
        subtitle="提醒任务的状态、错过原因与失败明细（结果未知的任务需人工核实手机是否已收到）"
        className="mt-4"
      >
        <NotificationLog />
      </Card>

      <Card title="数据管理" subtitle="备份与导出" className="mt-4">
        <ul className="space-y-2 text-sm text-muted">
          <li>· 数据库每日自动备份并保留历史副本，具体策略见服务器上的备份脚本。</li>
          <li>· 订阅 / 付款 CSV 导出与完整业务数据 JSON 导出将在阶段 6 提供界面入口。</li>
          <li>· 日志与通知记录中不保存明文口令、完整 token、微信会话凭证和原始语音。</li>
        </ul>
      </Card>
    </>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'error' | 'idle';
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="flex items-center gap-2 text-right font-medium">
        {tone ? <StatusDot tone={tone} /> : null}
        {value}
      </dd>
    </div>
  );
}

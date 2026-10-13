import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { ApiError, api } from '../api';
import { Alert, Spinner } from '../components/ui';
import { useAuth } from '../hooks/useAuth';

/**
 * 强制改密页。
 *
 * 出现的时机：账号由管理员创建、或密码被管理员重置。此时服务端会拒绝
 * 除「查自己是谁 / 改密 / 登出」外的所有接口（403 password_change_required），
 * 因此这里不是"提示一下、可以跳过"的检查，而是唯一能走下去的出口。
 *
 * 刻意不套用主 Layout：侧边栏与底部导航指向的每个页面此刻都会被服务端拒绝，
 * 让用户点进去只会得到一片 403。
 */
export function ChangePasswordPage() {
  const { user, logout, refresh } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /**
   * 已经不需要改密时不要停在这一页。
   *
   * 改密成功后 `refresh()` 会把 mustChangePassword 置为 false，此处随即放行到主界面；
   * 同时也顺手挡掉"已登录用户手输 /change-password"的情况（设置页本来就有改密入口）。
   */
  if (user && !user.mustChangePassword) return <Navigate to="/" replace />;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }
    if (newPassword === currentPassword) {
      setError('新密码不能与当前密码相同');
      return;
    }

    setSubmitting(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      // 先刷新账号状态：mustChangePassword 变为 false 后，路由守卫才会放行到主界面。
      // 不刷新就跳转会被守卫弹回本页，表现为"改了密码却还在这一页"。
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '修改失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="relative mx-auto mb-4 flex h-12 w-12 -rotate-6 items-center justify-center rounded-md bg-brand font-serif text-xl font-bold text-white shadow-card">
            密
            <span aria-hidden="true" className="tape absolute -top-2 left-1/2 h-3 w-10 -translate-x-1/2 opacity-80" />
          </span>
          <h1 className="font-serif text-2xl tracking-tight">先设置你的密码</h1>
          <p className="mt-1.5 text-sm text-muted">
            {user ? `当前账号：${user.username}` : '当前账号'}
          </p>
        </div>

        <div className="card mb-4 p-4">
          <p className="text-sm text-muted">
            你正在使用管理员设置的<strong className="text-ink">一次性初始密码</strong>。
            请设置一个只有你自己知道的新密码，完成之前无法使用其他功能。
          </p>
        </div>

        <form onSubmit={handleSubmit} className="card space-y-4 p-6">
          <div>
            <label className="label" htmlFor="current-password">
              初始密码（管理员给你的那个）
            </label>
            <input
              id="current-password"
              type="password"
              className="input"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
              autoFocus
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

          {error ? <Alert>{error}</Alert> : null}

          <button type="submit" className="btn-primary w-full" disabled={submitting}>
            {submitting ? <Spinner /> : null}
            {submitting ? '保存中…' : '设置新密码并继续'}
          </button>

          <button
            type="button"
            className="btn-ghost w-full"
            onClick={() => void logout()}
            disabled={submitting}
          >
            退出登录
          </button>
        </form>

        <p className="mt-5 text-center text-xs text-muted">
          修改成功后，其他设备上的登录会立即失效
        </p>
      </div>
    </div>
  );
}

import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { ApiError } from '../api';
import { Alert, Spinner } from '../components/ui';
import { useAuth } from '../hooks/useAuth';

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <Spinner className="text-brand" />
      </div>
    );
  }

  // 首次登录（或密码被管理员重置后）必须先改密，直接送到改密页，
  // 而不是先进主界面再被守卫弹回来
  if (user) return <Navigate to={user.mustChangePassword ? '/change-password' : '/'} replace />;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '登录失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="relative mx-auto mb-4 flex h-12 w-12 -rotate-6 items-center justify-center rounded-md bg-brand font-serif text-xl font-bold text-white shadow-card">
            生
            <span aria-hidden="true" className="tape absolute -top-2 left-1/2 h-3 w-10 -translate-x-1/2 opacity-80" />
          </span>
          <h1 className="font-serif text-2xl tracking-tight">Life OS</h1>
          <p className="mt-1.5 text-sm text-muted">个人生活与事务管理工作站</p>
        </div>

        <form onSubmit={handleSubmit} className="card space-y-4 p-6">
          <div>
            <label className="label" htmlFor="username">
              用户名
            </label>
            <input
              id="username"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              required
              autoFocus
            />
          </div>

          <div>
            <label className="label" htmlFor="password">
              密码
            </label>
            <input
              id="password"
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>

          {error ? <Alert>{error}</Alert> : null}

          <button type="submit" className="btn-primary w-full" disabled={submitting}>
            {submitting ? <Spinner /> : null}
            {submitting ? '登录中…' : '登录'}
          </button>
        </form>

        <p className="mt-5 text-center text-xs text-muted">
          账号由管理员创建 · 无注册入口 · 忘记密码请联系管理员重置
        </p>
      </div>
    </div>
  );
}

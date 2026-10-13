import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, api, type ManagedUserDto, type ResetPasswordResponse } from '../api';
import { Alert, Card, EmptyState, Spinner } from './ui';

/**
 * 账号管理（仅管理员可见）。
 *
 * 三条产品约束在这里的体现：
 * 1. **不开放注册**：这是唯一的建号入口，没有自助注册；
 * 2. **不提供删除**：删除会连带清掉该账号的全部业务数据（所有业务表都是 CASCADE），
 *    不可逆，因此只提供"禁用"。界面上不出现删除按钮，避免误触不可逆操作；
 * 3. **重置密码给的是系统生成的一次性密码**，并强制对方下次登录改密——
 *    管理员不该知道、也不该设定别人的长期密码。
 *
 * 界面侧的护栏（不能禁用自己、不能禁用最后一个启用中的管理员）只是**提前说明原因**，
 * 真正的判定在服务端；即使有人绕过界面直接调接口，也会被拒绝。
 */
export function AccountManagement() {
  const [users, setUsers] = useState<ManagedUserDto[] | null>(null);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const [newUsername, setNewUsername] = useState('');
  const [newIsAdmin, setNewIsAdmin] = useState(false);
  const [creating, setCreating] = useState(false);

  /** 刚生成的一次性密码：只显示这一次，不写进任何持久化状态 */
  const [issued, setIssued] = useState<(ResetPasswordResponse & { forUsername: string }) | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.users();
      setUsers(res.users);
      setCurrentUserId(res.currentUserId);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '读取账号列表失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const enabledAdminCount = (users ?? []).filter((u) => u.isAdmin && !u.disabled).length;

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const res = await api.createUser(newUsername.trim(), newIsAdmin);
      setIssued({ ...res, forUsername: res.user.username });
      setCopied(false);
      setNewUsername('');
      setNewIsAdmin(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建失败');
    } finally {
      setCreating(false);
    }
  }

  async function toggleDisabled(user: ManagedUserDto) {
    setError(null);
    setBusyId(user.id);
    try {
      if (user.disabled) await api.enableUser(user.id);
      else await api.disableUser(user.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '操作失败');
    } finally {
      setBusyId(null);
    }
  }

  async function resetPassword(user: ManagedUserDto) {
    setError(null);
    setBusyId(user.id);
    try {
      const res = await api.resetUserPassword(user.id);
      setIssued({ ...res, forUsername: user.username });
      setCopied(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '重置失败');
    } finally {
      setBusyId(null);
    }
  }

  /** 为什么某个账号不能被禁用——返回原因字符串，可禁用时返回 null */
  function disableBlockedReason(user: ManagedUserDto): string | null {
    if (user.disabled) return null;
    if (user.id === currentUserId) return '不能禁用当前登录的账号：你会立刻掉线且无法自行恢复';
    if (user.isAdmin && enabledAdminCount <= 1) return '这是唯一启用中的管理员，禁用后将没有人能再管理账号';
    return null;
  }

  return (
    <Card title="账号管理" subtitle="新增、禁用与重置密码（不开放注册）" className="mt-4">
      {error ? <Alert>{error}</Alert> : null}

      {issued ? (
        <div className="mb-4 rounded-xl border-[1.5px] border-brand/40 bg-brand/5 p-4">
          <p className="text-sm font-medium text-ink">
            账号 <span className="font-mono">{issued.forUsername}</span> 的一次性初始密码
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="select-all rounded-lg bg-canvas px-3 py-2 font-mono text-sm text-ink">{issued.initialPassword}</code>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(issued.initialPassword)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? '已复制' : '复制'}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setIssued(null)}>
              我已记下，关闭
            </button>
          </div>
          <p className="mt-2 text-xs text-muted">{issued.notice}</p>
          <p className="mt-1 text-xs text-muted">
            ⚠️ 关掉这段提示后就再也看不到这个密码了（服务端只保存哈希），届时只能再次重置。
          </p>
        </div>
      ) : null}

      <form onSubmit={handleCreate} className="mb-5 space-y-3 border-b border-dashed border-line pb-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <label className="label" htmlFor="new-account-username">
              新账号用户名
            </label>
            <input
              id="new-account-username"
              className="input"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder="字母、数字、下划线、点、连字符，3-64 位"
              autoCapitalize="none"
              autoCorrect="off"
              required
            />
          </div>
          <button type="submit" className="btn-primary shrink-0" disabled={creating || !newUsername.trim()}>
            {creating ? <Spinner /> : null}
            创建账号
          </button>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={newIsAdmin}
            onChange={(e) => setNewIsAdmin(e.target.checked)}
          />
          设为管理员（可管理账号；不影响数据隔离——管理员**看不到**别人的业务数据）
        </label>
      </form>

      {users === null ? (
        <div className="flex justify-center py-6">
          <Spinner className="text-brand" />
        </div>
      ) : users.length === 0 ? (
        <EmptyState title="还没有任何账号" description="理论上不会出现：系统至少应有一个管理员账号。" />
      ) : (
        <ul className="space-y-3">
          {users.map((user) => {
            const blocked = disableBlockedReason(user);
            return (
              <li
                key={user.id}
                className="rounded-xl border border-line bg-canvas/40 p-3.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{user.username}</span>
                  {user.id === currentUserId ? <span className="chip bg-brand/10 text-brand">当前账号</span> : null}
                  <span className={`chip ${user.isAdmin ? 'bg-subscription-soft text-subscription' : 'bg-task-soft text-task'}`}>
                    {user.isAdmin ? '管理员' : '普通用户'}
                  </span>
                  {user.disabled ? <span className="chip bg-red-500/10 text-red-500">已禁用</span> : null}
                  {user.mustChangePassword ? <span className="chip bg-subscription-soft text-subscription">待改密</span> : null}
                </div>

                <p className="mt-1 text-xs text-muted">
                  在线会话 {user.activeSessions} 个 · 创建于 {new Date(user.createdAt).toLocaleDateString('zh-CN')}
                  {blocked ? ` · ${blocked}` : ''}
                </p>

                <div className="mt-2.5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busyId === user.id || blocked !== null}
                    title={blocked ?? undefined}
                    onClick={() => void toggleDisabled(user)}
                  >
                    {busyId === user.id ? <Spinner /> : null}
                    {user.disabled ? '启用' : '禁用'}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busyId === user.id}
                    onClick={() => void resetPassword(user)}
                    title="生成一次性密码并强制对方下次登录改密"
                  >
                    重置密码
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-4 text-xs text-muted">
        禁用会立刻撤销该账号的全部登录会话；系统不提供删除账号（会连带清空其业务数据，不可逆）。
      </p>
    </Card>
  );
}

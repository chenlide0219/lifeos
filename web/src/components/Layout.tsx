import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../hooks/useTheme';
import { VoiceCapture } from './VoiceCapture';
import {
  IconAnalytics,
  IconCalendar,
  IconDashboard,
  IconLogout,
  IconMic,
  IconMonitor,
  IconMoon,
  IconSettings,
  IconSubscription,
  IconSun,
  IconTodo,
} from './Icons';

const NAV = [
  { to: '/', label: '总览', Icon: IconDashboard },
  { to: '/calendar', label: '日历', Icon: IconCalendar },
  { to: '/todo', label: '待办', Icon: IconTodo },
  { to: '/subscriptions', label: '订阅', Icon: IconSubscription },
  { to: '/analytics', label: '统计', Icon: IconAnalytics },
  { to: '/settings', label: '设置', Icon: IconSettings },
] as const;

/** 移动端底部导航：5 项，设置从顶部入口进入 */
const MOBILE_NAV = NAV.filter((item) => item.to !== '/settings');

function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { mode, cycle } = useTheme();
  const Icon = mode === 'dark' ? IconMoon : mode === 'light' ? IconSun : IconMonitor;
  const label = mode === 'dark' ? '深色模式' : mode === 'light' ? '浅色模式' : '跟随系统';

  return (
    <button
      type="button"
      onClick={cycle}
      title={`主题：${label}`}
      aria-label={`切换主题，当前${label}`}
      className={
        compact
          ? 'inline-flex h-9 w-9 items-center justify-center rounded-xl border border-line text-muted transition-colors hover:text-ink'
          : 'nav-item w-full'
      }
    >
      <Icon />
      {compact ? null : <span>{label}</span>}
    </button>
  );
}

export function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const current = NAV.find((item) => item.to === location.pathname);
  const [voiceOpen, setVoiceOpen] = useState(false);

  return (
    <div className="min-h-screen bg-canvas">
      {/* ── 桌面端左侧导航 ── */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line bg-surface md:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand text-sm font-bold text-white">
            L
          </span>
          <span className="text-[15px] font-semibold tracking-tight">Life OS</span>
        </div>

        <nav className="flex-1 space-y-1 px-3">
          {NAV.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => `nav-item ${isActive ? 'nav-item-active' : ''}`}
            >
              <Icon />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="space-y-1 border-t border-line p-3">
          <ThemeToggle />
          <div className="flex items-center justify-between gap-2 rounded-xl px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{user?.username}</p>
              <p className="text-xs text-muted">管理员</p>
            </div>
            <button
              type="button"
              onClick={() => void logout()}
              title="退出登录"
              aria-label="退出登录"
              className="rounded-lg p-2 text-muted transition-colors hover:bg-canvas hover:text-ink"
            >
              <IconLogout />
            </button>
          </div>
        </div>
      </aside>

      {/* ── 移动端顶栏 ── */}
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-surface/90 px-4 py-3 backdrop-blur md:hidden">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-xs font-bold text-white">
            L
          </span>
          <span className="text-sm font-semibold">{current?.label ?? 'Life OS'}</span>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle compact />
          <NavLink
            to="/settings"
            aria-label="设置"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-line text-muted transition-colors hover:text-ink"
          >
            <IconSettings />
          </NavLink>
        </div>
      </header>

      {/* ── 内容区 ── */}
      {/* 底部留白躲开移动端底栏与桌面端的麦克风浮钮 */}
      <main className="px-4 pb-28 pt-5 sm:px-6 md:ml-60 md:pb-28 md:pt-8">
        <div className="mx-auto max-w-5xl">
          <Outlet />
        </div>
      </main>

      {/* ── 移动端麦克风快捷入口（PRD 3.2） ── */}
      <button
        type="button"
        onClick={() => setVoiceOpen(true)}
        title="语音录入"
        aria-label="语音录入"
        className="fixed bottom-24 right-4 z-30 flex h-14 w-14 items-center justify-center rounded-2xl
                   bg-brand text-white shadow-pop transition-transform active:scale-95
                   md:bottom-8 md:right-8"
      >
        <IconMic width={24} height={24} />
      </button>

      <VoiceCapture
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        onCreated={() => setVoiceOpen(false)}
      />

      {/* ── 移动端底部导航 ── */}
      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        <div className="grid grid-cols-5">
          {MOBILE_NAV.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium transition-colors ${
                  isActive ? 'text-brand' : 'text-muted'
                }`
              }
            >
              <Icon width={22} height={22} />
              <span>{label}</span>
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}

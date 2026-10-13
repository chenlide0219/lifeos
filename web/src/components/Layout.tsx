import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../hooks/useTheme';
import { VoiceCapture } from './VoiceCapture';
import {
  IconAnalytics,
  IconCalendar,
  IconDashboard,
  IconEvent,
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
  { to: '/events', label: '事件', Icon: IconEvent },
  { to: '/todo', label: '待办', Icon: IconTodo },
  { to: '/subscriptions', label: '订阅', Icon: IconSubscription },
  { to: '/analytics', label: '统计', Icon: IconAnalytics },
  { to: '/settings', label: '设置', Icon: IconSettings },
] as const;

/** 移动端底部导航：设置从顶部入口进入 */
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
          ? 'inline-flex h-11 w-11 items-center justify-center rounded-full border-[1.5px] border-line text-muted transition-colors hover:text-ink'
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
      <a href="#main-content" className="skip-link">跳转到主要内容</a>
      {/* ── 桌面端左侧导航 ── */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r-[1.5px] border-dashed border-line bg-surface md:flex">
        <div className="flex items-center gap-3 px-6 pb-8 pt-8">
          <span className="relative flex h-9 w-9 -rotate-6 items-center justify-center rounded-md bg-brand font-serif text-base font-bold text-white shadow-card">
            生
            <span aria-hidden="true" className="tape absolute -top-2 left-1/2 h-2.5 w-8 -translate-x-1/2 opacity-80" />
          </span>
          <div><span className="font-serif text-lg tracking-tight">Life OS</span><p className="text-[10px] tracking-[0.28em] text-pencil">个人工作站</p></div>
        </div>

        <nav aria-label="主导航" className="flex-1 space-y-1 px-4">
          <p className="px-3 pb-2 text-[11px] font-medium tracking-widest text-pencil">工作空间</p>
          {NAV.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => `nav-item ${to === '/subscriptions' ? '!mt-6' : ''} ${isActive ? 'nav-item-active' : ''}`}
            >
              <Icon />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="space-y-1 border-t-[1.5px] border-dashed border-line p-3">
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
      <header className="sticky top-0 z-20 flex items-center justify-between border-b-[1.5px] border-dashed border-line bg-surface px-4 py-2 md:hidden">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-8 w-8 -rotate-6 items-center justify-center rounded-md bg-brand font-serif text-sm font-bold text-white shadow-card">
            生
            <span aria-hidden="true" className="tape absolute -top-2 left-1/2 h-2.5 w-7 -translate-x-1/2 opacity-80" />
          </span>
          <span className="font-serif text-[15px] tracking-tight">{current?.label ?? 'Life OS'}</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" aria-label="语音录入" title="语音录入" onClick={() => setVoiceOpen(true)} className="inline-flex h-11 w-11 items-center justify-center rounded-full border-[1.5px] border-ink text-ink"><IconMic /></button>
          <ThemeToggle compact />
          <NavLink
            to="/settings"
            aria-label="设置"
            className="inline-flex h-11 w-11 items-center justify-center rounded-full border-[1.5px] border-line text-muted transition-colors hover:text-ink"
          >
            <IconSettings />
          </NavLink>
        </div>
      </header>

      {/* ── 内容区 ── */}
      {/* 底部留白躲开移动端底栏与桌面端的麦克风浮钮 */}
      <main id="main-content" tabIndex={-1} className="min-w-0 px-4 pb-44 pt-6 sm:px-8 md:ml-60 md:pb-32 md:pt-10 lg:px-12">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>

      {/* ── 移动端麦克风快捷入口（PRD 3.2） ── */}
      <button
        type="button"
        onClick={() => setVoiceOpen(true)}
        title="语音录入"
        aria-label="语音录入"
        className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-30 hidden h-12 w-12 -rotate-3 items-center justify-center rounded-full
                   bg-brand text-white shadow-pop ring-2 ring-inset ring-white/40 transition-transform active:scale-95
                   md:bottom-8 md:right-8 md:flex"
      >
        <IconMic width={24} height={24} />
      </button>

      <VoiceCapture
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        onCreated={() => setVoiceOpen(false)}
      />

      {/* ── 移动端底部导航 ── */}
      <nav aria-label="手机导航" className="fixed inset-x-0 bottom-0 z-20 border-t-[1.5px] border-dashed border-line bg-surface-2 pb-[env(safe-area-inset-bottom)] md:hidden">
        <div className="grid grid-cols-6">
          {MOBILE_NAV.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex min-w-0 flex-col items-center gap-1 py-2.5 text-[10px] transition-colors ${
                  isActive ? 'font-bold text-ink' : 'font-medium text-pencil'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon width={21} height={21} />
                  <span>{label}</span>
                  {/* 当前页：印章红圆点（不靠整块底色，收敛一些） */}
                  <span aria-hidden="true" className={`h-1 w-1 rounded-full ${isActive ? 'bg-brand' : 'bg-transparent'}`} />
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}

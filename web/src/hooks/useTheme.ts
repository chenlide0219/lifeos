import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'lifeos.theme';
const CHANGE = 'lifeos-theme-change';
let fallback: ThemeMode = 'system';
function read(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' || value === 'system' ? value : fallback;
  } catch { return fallback; }
}
function subscribe(notify: () => void) {
  window.addEventListener(CHANGE, notify);
  window.addEventListener('storage', notify);
  return () => { window.removeEventListener(CHANGE, notify); window.removeEventListener('storage', notify); };
}
function setMode(mode: ThemeMode) {
  fallback = mode;
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* Private browser storage may be unavailable. */ }
  window.dispatchEvent(new Event(CHANGE));
}
export function useTheme() {
  const mode = useSyncExternalStore(subscribe, read, () => 'system' as ThemeMode);
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', mode === 'dark' || (mode === 'system' && query.matches));
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [mode]);
  const cycle = useCallback(() => { const current = read(); setMode(current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light'); }, []);
  return { mode, setMode, cycle };
}

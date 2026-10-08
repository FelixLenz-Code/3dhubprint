import { NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, Boxes, ClipboardList, Disc3, LayoutGrid, LogOut, Settings, WifiOff } from 'lucide-react';
import clsx from 'clsx';
import type { Me } from '@printhub/shared';
import { api } from '../lib/api';
import { useRefreshAuth } from '../lib/auth';
import { useLive } from '../lib/live';

const NAV: { to: string; label: string; short?: string; icon: typeof Settings; end: boolean }[] = [
  { to: '/', label: 'Drucker', icon: LayoutGrid, end: true },
  { to: '/jobs', label: 'Aufträge', icon: ClipboardList, end: false },
  { to: '/models', label: 'Modelle', icon: Boxes, end: false },
  { to: '/spools', label: 'Spulen', icon: Disc3, end: false },
  { to: '/stats', label: 'Statistik', icon: BarChart3, end: false },
  // Six tabs don't fit "Einstellungen" on narrow phones.
  { to: '/settings', label: 'Einstellungen', short: 'Optionen', icon: Settings, end: false },
];

export function Layout({ user }: { user: Me }) {
  const refreshAuth = useRefreshAuth();
  const connection = useLive((s) => s.connection);
  const health = useQuery({ queryKey: ['health'], queryFn: () => api<{ version: string }>('/health'), staleTime: Infinity });

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    await refreshAuth();
  };

  return (
    <div className="min-h-dvh md:flex">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-border bg-surface p-4 md:flex">
        <div className="mb-8 flex items-center gap-2 px-2">
          <img src="/icon.svg" alt="" className="size-8" />
          <span className="text-lg font-semibold">PrintHub</span>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium',
                  isActive ? 'bg-surface-2 text-text' : 'text-text-2 hover:bg-surface-2 hover:text-text',
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto flex items-center justify-between gap-2 border-t border-border px-2 pt-4 text-sm">
          <div className="min-w-0">
            <div className="truncate text-text-2">{user.username}</div>
            <div className="truncate text-xs text-text-3">
              {health.data && `Version ${health.data.version} · `}
              {/* AGPL §13: offer the source to everyone using the app over the network. */}
              <a href="https://github.com/FelixLenz-Code/3dhubprint" target="_blank" rel="noreferrer" className="hover:text-text">
                Quellcode
              </a>
            </div>
          </div>
          <button onClick={logout} className="rounded-lg p-2 text-text-3 hover:bg-surface-2 hover:text-text" title="Abmelden">
            <LogOut className="size-4" />
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 pb-24 pt-[max(1rem,env(safe-area-inset-top))] md:px-8 md:pb-8 md:pt-8">
        {connection === 'closed' && (
          <div className="mb-4 flex items-center gap-2 rounded-lg bg-warning/12 px-3 py-2 text-sm text-warning">
            <WifiOff className="size-4" /> Verbindung zum Server unterbrochen, verbinde neu…
          </div>
        )}
        <Outlet />
      </main>

      {/* Mobile bottom navigation */}
      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {NAV.map(({ to, label, short, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            aria-label={label}
            className={({ isActive }) =>
              clsx('flex min-w-0 flex-1 flex-col items-center gap-1 py-2.5 text-xs', isActive ? 'text-accent' : 'text-text-3')
            }
          >
            <Icon className="size-5" />
            <span className="max-w-full truncate">{short ?? label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

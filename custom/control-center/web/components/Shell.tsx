import { Link, Outlet } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { NAV_GROUPS } from '../nav';
import { apiGet } from '../lib/api';
import { useLiveInvalidation } from '../lib/sse';
import { useCallback, useEffect, useState } from 'react';
import { AskDrawer, useAskHotkey } from './AskDrawer';
import { CommandPalette } from './CommandPalette';
import { ConfirmProvider } from './ConfirmDialog';
import { UsageMeter } from '../features/settings/UsageMeter';
import { useReloadStatus } from '../features/dev/DevChatPage';
import type { SystemStatus } from '@shared/types';
import type { DailyStatus, RunMeta, ScheduleLogs, SessionMeta } from '@shared/api';

function DailyBanner() {
  const q = useQuery({ queryKey: ['system', 'daily'], queryFn: () => apiGet<DailyStatus>('/api/system/daily'), refetchInterval: 10_000 });
  if (!q.data?.running) return null;
  return (
    <div className="banner" role="status">
      The daily job (run-daily.sh) is running. Writers stay available; the core locks serialize them.
    </div>
  );
}

function DailyJobChip() {
  const q = useQuery({ queryKey: ['immigration', 'logs', 'immigration-watch'], queryFn: () => apiGet<ScheduleLogs>('/api/schedule/logs?job=immigration-watch') });
  const latest = q.data?.latest;
  if (!latest) return null;
  const ok = latest.status === 'ok';
  return (
    <Link to="/runs" className={`chip ${ok ? 'chip--ok' : latest.status === 'failed' ? 'chip--danger' : 'chip--warn'}`} aria-label={`Daily job ${latest.date}: ${latest.status}`}>
      Daily {latest.date.slice(5)}: {latest.status}
    </Link>
  );
}

function HealthChip() {
  const q = useQuery({ queryKey: ['system', 'status'], queryFn: () => apiGet<SystemStatus>('/api/system/status') });
  if (q.isPending) return <span className="chip" aria-busy="true">Checking setup</span>;
  if (q.isError) return <span className="chip chip--danger">Status unavailable</span>;
  const s = q.data;
  const ok = Boolean(s.claude.version) && s.keychainTokenPresent;
  return (
    <Link to="/settings" search={{ tab: 'engine' }} className={`chip ${ok ? 'chip--ok' : 'chip--warn'}`} title={ok ? 'Claude CLI and Keychain token found' : 'Setup incomplete: see Settings'}>
      {ok ? 'Setup OK' : 'Setup needs attention'}
    </Link>
  );
}

function ReloadBanner() {
  const q = useReloadStatus();
  const s = q.data;
  if (!s || s.state !== 'failed') return null;
  return (
    <div className="banner" role="alert">
      Server reload failed: {s.error}. The previous server keeps running. Review the change in <Link to="/dev">Dev Chat</Link> or open <a href="/__recovery">/__recovery</a>.
    </div>
  );
}

function ActivityChip() {
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => apiGet<SessionMeta[]>('/api/sessions'), refetchInterval: 5000 });
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => apiGet<RunMeta[]>('/api/runs'), refetchInterval: 5000 });
  const active = (sessions.data ?? []).filter((s) => s.status === 'running' || s.status === 'queued').length + (runs.data ?? []).filter((r) => (r.status === 'running' || r.status === 'queued') && !r.actionId.startsWith('session.')).length;
  const waiting = (sessions.data ?? []).filter((s) => s.status === 'awaiting_user').length;
  return (
    <Link to="/sessions" className={`chip ${active ? 'chip--info' : waiting ? 'chip--warn' : 'chip--neutral'}`} aria-label={`Activity: ${active} running, ${waiting} waiting for you`}>
      {active ? `${active} running` : waiting ? `${waiting} waiting for you` : 'Idle'}
    </Link>
  );
}

function usePaletteHotkey(toggle: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);
}

export function Shell() {
  useLiveInvalidation();
  const [ask, setAsk] = useState(false);
  const [palette, setPalette] = useState(false);
  const toggleAsk = useCallback(() => setAsk((o) => !o), []);
  const togglePalette = useCallback(() => setPalette((o) => !o), []);
  useAskHotkey(toggleAsk);
  usePaletteHotkey(togglePalette);
  return (
    <ConfirmProvider>
      <div className="shell">
        <nav className="shell__side" aria-label="Primary">
          <div className="brand">
            <span className="brand__dot" aria-hidden="true" />
            <span>Control Center</span>
          </div>
          {NAV_GROUPS.map((g) => (
            <div className="nav-group" key={g.label}>
              <div className="nav-group__label">{g.label}</div>
              {g.items.map((item) => (
                <Link key={item.to} to={item.to} className="nav-link" activeOptions={{ exact: item.to === '/' }} activeProps={{ 'aria-current': 'page' }}>
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
          <div className="nav-group nav-group--bottom">
            <UsageMeter compact />
          </div>
        </nav>
        <header className="shell__top">
          <button type="button" className="palette-trigger" onClick={togglePalette} aria-label="Open command palette" title="Command palette (Cmd+K)">
            Search or run <kbd>Cmd K</kbd>
          </button>
          <span style={{ flex: 1 }} />
          <DailyJobChip />
          <ActivityChip />
          <HealthChip />
          <button type="button" onClick={toggleAsk} aria-expanded={ask} aria-label="Open Ask drawer" title="Ask the advisor (Cmd+J)">
            Ask
          </button>
        </header>
        <main className="shell__main" id="main">
          <ReloadBanner />
          <DailyBanner />
          <Outlet />
        </main>
        <AskDrawer open={ask} onClose={() => setAsk(false)} />
        <CommandPalette open={palette} onOpenChange={setPalette} />
        <Toaster theme="dark" position="bottom-right" closeButton />
      </div>
    </ConfirmProvider>
  );
}

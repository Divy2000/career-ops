import { Link, Outlet } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { NAV_GROUPS } from '../nav';
import { apiGet } from '../lib/api';
import { useLiveInvalidation } from '../lib/sse';
import { useCallback, useState } from 'react';
import { AskDrawer, useAskHotkey } from './AskDrawer';
import { useReloadStatus } from '../features/dev/DevChatPage';
import type { SystemStatus } from '@shared/types';
import type { DailyStatus, RunMeta, SessionMeta } from '@shared/api';

function DailyBanner() {
  const q = useQuery({ queryKey: ['system', 'daily'], queryFn: () => apiGet<DailyStatus>('/api/system/daily'), refetchInterval: 10_000 });
  if (!q.data?.running) return null;
  return (
    <div className="banner" role="status">
      The daily job (run-daily.sh) is running. Writers stay available; the core locks serialize them.
    </div>
  );
}

function HealthChip() {
  const q = useQuery({ queryKey: ['system', 'status'], queryFn: () => apiGet<SystemStatus>('/api/system/status') });
  if (q.isPending) return <span className="chip" aria-busy="true">Checking setup</span>;
  if (q.isError) return <span className="chip chip--danger">Status unavailable</span>;
  const s = q.data;
  const ok = Boolean(s.claude.version) && s.keychainTokenPresent;
  return (
    <span className={`chip ${ok ? 'chip--ok' : 'chip--warn'}`} title={ok ? 'Claude CLI and Keychain token found' : 'Setup incomplete: see Settings'}>
      {ok ? 'Setup OK' : 'Setup needs attention'}
    </span>
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

export function Shell() {
  useLiveInvalidation();
  const [ask, setAsk] = useState(false);
  const toggleAsk = useCallback(() => setAsk((o) => !o), []);
  useAskHotkey(toggleAsk);
  return (
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
      </nav>
      <header className="shell__top">
        <span className="muted">career-ops</span>
        <span style={{ flex: 1 }} />
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
    </div>
  );
}

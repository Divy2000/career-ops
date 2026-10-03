import { Link, Outlet } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { NAV_GROUPS } from '../nav';
import { apiGet } from '../lib/api';
import { useLiveInvalidation } from '../lib/sse';
import type { SystemStatus } from '@shared/types';

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

export function Shell() {
  useLiveInvalidation();
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
        <HealthChip />
      </header>
      <main className="shell__main" id="main">
        <Outlet />
      </main>
    </div>
  );
}

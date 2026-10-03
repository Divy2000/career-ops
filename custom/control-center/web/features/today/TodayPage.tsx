import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api';
import type { SystemStatus } from '@shared/types';

export function TodayPage() {
  const q = useQuery({ queryKey: ['system', 'status'], queryFn: () => apiGet<SystemStatus>('/api/system/status') });
  const today = new Date().toISOString().slice(0, 10);
  return (
    <section aria-labelledby="page-title">
      <div className="page-header">
        <h1 id="page-title">Today</h1>
        <span className="muted mono">{today}</span>
      </div>
      <div className="card" aria-busy={q.isPending}>
        <h2 style={{ marginBottom: 'var(--space-3)' }}>System</h2>
        {q.isPending && <p className="muted">Loading system status</p>}
        {q.isError && <p style={{ color: 'var(--danger)' }}>Could not load system status: {String(q.error)}</p>}
        {q.data && (
          <dl className="kv">
            <dt>Node</dt>
            <dd className="mono">{q.data.node}</dd>
            <dt>Claude CLI</dt>
            <dd className="mono">{q.data.claude.version ?? q.data.claude.error ?? 'unknown'}</dd>
            <dt>Keychain token</dt>
            <dd>{q.data.keychainTokenPresent ? 'present' : 'missing'}</dd>
            <dt>Data root</dt>
            <dd className="mono">{q.data.roots.data}</dd>
            <dt>career-ops</dt>
            <dd className="mono">{q.data.careerOps.version ?? 'unknown'}</dd>
          </dl>
        )}
      </div>
    </section>
  );
}

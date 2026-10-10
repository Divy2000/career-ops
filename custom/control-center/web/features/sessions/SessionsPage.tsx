import { useCallback, useRef, useState } from 'react';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiSend } from '../../lib/api';
import { describeError } from '../../lib/actions';
import { useSessions } from '../../lib/sessions';
import { SessionPanel, StatusLabel } from '../../components/SessionPanel';
import { DataState, Empty, TableScroll } from '../../components/ui';
import { useConfirm } from '../../components/ConfirmDialog';
import { toast } from 'sonner';
import type { ModePolicy, SessionMeta } from '@shared/api';
import { formatLocalMinute } from '../../lib/time';
import { forgetDevSession } from '../../lib/devchatSession';

const detailRoute = getRouteApi('/sessions/$id');

export function describeTarget(t: SessionMeta['target']): string {
  if (t.type === 'none' || !t.value) return '';
  if (t.type === 'app') return `#${t.value}`;
  return t.value.length > 60 ? `${t.value.slice(0, 57)}...` : t.value;
}

export function SessionsPage() {
  const sessions = useSessions();
  const modes = useQuery({ queryKey: ['modes'], queryFn: () => apiGet<ModePolicy[]>('/api/modes'), staleTime: 60_000 });
  const [filter, setFilter] = useState({ mode: '', status: '' });
  const [newMode, setNewMode] = useState('oferta');
  const [targetValue, setTargetValue] = useState('');
  const [open, setOpen] = useState(false);
  const rows = (sessions.data ?? []).filter((s) => (!filter.mode || s.mode === filter.mode) && (!filter.status || s.status === filter.status));
  return (
    <section aria-labelledby="page-title">
      <div className="page-header">
        <h1 id="page-title">Sessions</h1>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          New session
        </button>
      </div>
      {open && (
        <div className="card">
          <h2>New session</h2>
          <div className="row gap">
            <label>
              Mode{' '}
              <select aria-label="New session mode" value={newMode} onChange={(e) => setNewMode(e.target.value)}>
                {(modes.data ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id} ({m.policyClass})
                  </option>
                ))}
              </select>
            </label>
            <label style={{ flex: 1 }}>
              {newMode === 'projects-ingest' ? 'Source document (path under documents/)' : 'Target (URL, company or row number)'}{' '}
              <input aria-label="New session target" value={targetValue} onChange={(e) => setTargetValue(e.target.value)} placeholder={newMode === 'projects-ingest' ? 'projects/my-project.pdf' : 'optional'} />
            </label>
          </div>
          <SessionPanel key={newMode} mode={newMode} target={targetFor(targetValue, newMode)} placeholder="What should this session do?" />
        </div>
      )}
      <div className="toolbar row gap">
        <label>
          Mode{' '}
          <select aria-label="Filter by mode" value={filter.mode} onChange={(e) => setFilter({ ...filter, mode: e.target.value })}>
            <option value="">all</option>
            {[...new Set((sessions.data ?? []).map((s) => s.mode))].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status{' '}
          <select aria-label="Filter by status" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
            <option value="">all</option>
            {['queued', 'running', 'awaiting_user', 'done', 'error', 'cancelled'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      <DataState query={sessions}>
        {(sessions.data ?? []).length === 0 ? (
          <Empty>No sessions yet. Start one with New session or from any page's AI panel.</Empty>
        ) : rows.length === 0 ? (
          <Empty>No sessions match the filters.</Empty>
        ) : (
          <TableScroll label="Sessions">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Target</th>
                  <th scope="col">Turns</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <StatusLabel status={s.status} />
                    </td>
                    <td>
                      <Link to="/sessions/$id" params={{ id: s.id }}>
                        {s.mode}
                      </Link>
                    </td>
                    <td className="muted">{describeTarget(s.target)}</td>
                    <td className="mono">{s.turns.length}</td>
                    <td className="mono">${s.totals.costUsd.toFixed(3)}</td>
                    <td className="mono muted">{formatLocalMinute(s.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </DataState>
    </section>
  );
}

/** projects-ingest reads a document under documents/, which the route takes as a text target. */
export function targetFor(value: string, mode?: string): SessionMeta['target'] {
  const v = value.trim();
  if (!v) return { type: 'none', value: null };
  if (mode === 'projects-ingest') return { type: 'text', value: v };
  if (/^\d+$/.test(v)) return { type: 'app', value: v };
  if (/^https?:\/\//.test(v)) return { type: 'url', value: v };
  return { type: 'company', value: v };
}

export function SessionDetailPage() {
  const { id } = detailRoute.useParams();
  const q = useQuery({ queryKey: ['sessions', id], queryFn: () => apiGet<{ meta: SessionMeta }>(`/api/sessions/${id}`) });
  // The route keeps this page mounted when only $id changes, so the flag names the session it is about.
  const [deletedId, setDeletedId] = useState<string | null>(null);
  const deleted = deletedId === id;
  const confirm = useConfirm();
  const navigate = useNavigate();
  // A fork is a new session: the page follows it instead of showing the source.
  const openSession = (next: string) => {
    if (next !== id) void navigate({ to: '/sessions/$id', params: { id: next } });
  };
  // The meta query refreshes when a turn ends, not when a reply starts one; the live stream says running at once.
  // The stream never sends queued, so its starting value is not a status.
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const onStatus = useCallback((s: string) => setLiveStatus(s), []);
  // Confirms queue, so a second click while one is asking or deleting would ask twice: it is ignored.
  const asking = useRef(false);
  const remove = async () => {
    if (asking.current) return;
    asking.current = true;
    try {
      await removeAsked();
    } finally {
      asking.current = false;
    }
  };
  const removeAsked = async () => {
    if (!(await confirm({ title: 'Delete this session?', body: 'The transcript and its events are removed. Runs it started are kept.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await apiSend('DELETE', `/api/sessions/${id}`, {});
    } catch (err) {
      toast.error(`Could not delete the session: ${describeError(err)}`);
      return;
    }
    toast.success('Session deleted');
    forgetDevSession(id);
    setDeletedId(id);
  };
  return (
    <section aria-labelledby="page-title">
      <p>
        <Link to="/sessions">Back to sessions</Link>
      </p>
      <DataState query={q}>
        {q.data && !deleted && (
          <>
            <div className="page-header">
              <div>
                <h1 id="page-title">
                  {q.data.meta.mode} <span className="faint mono small">{q.data.meta.id}</span>
                </h1>
                <p className="muted" style={{ margin: 0 }}>
                  {describeTarget(q.data.meta.target)} {q.data.meta.forkedFrom && <span className="faint">forked from {q.data.meta.forkedFrom}</span>}
                </p>
              </div>
              <button
                type="button"
                disabled={q.data.meta.status === 'running' || q.data.meta.status === 'queued' || liveStatus === 'running'}
                onClick={() => void remove()}
              >
                Delete
              </button>
            </div>
            <SessionPanel key={id} mode={q.data.meta.mode} sessionId={id} target={q.data.meta.target} onSessionId={openSession} onStatus={onStatus} />
            <div className="card">
              <h2>Turns</h2>
              <TableScroll label="Turns">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Prompt</th>
                      <th scope="col">Cost</th>
                      <th scope="col">Tokens</th>
                      <th scope="col">Denials</th>
                      <th scope="col">Run</th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.meta.turns.map((t) => (
                      <tr key={t.n}>
                        <td className="mono">{t.n}</td>
                        <td>{t.userText.slice(0, 160)}</td>
                        <td className="mono">${t.costUsd.toFixed(4)}</td>
                        <td className="mono">{t.tokens}</td>
                        <td className="mono">{t.permissionDenials}</td>
                        <td className="mono faint">{t.runId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </div>
          </>
        )}
        {deleted && <Empty>Session deleted.</Empty>}
      </DataState>
    </section>
  );
}

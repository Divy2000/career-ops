import { useConfirm } from '../../components/ConfirmDialog';
import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend } from '../../lib/api';
import { isTerminal } from '../../lib/sessions';
import { describeError, useActions, useRunAction } from '../../lib/actions';
import { SessionPanel } from '../../components/SessionPanel';
import { ActionButton, Message } from '../../components/ActionBar';
import { Empty, Pill } from '../../components/ui';

interface FileDiff {
  path: string;
  abs: string;
  root: 'code' | 'data';
  status: 'added' | 'modified' | 'deleted' | 'unchanged' | 'no-snapshot' | 'unreadable';
  additions: number;
  deletions: number;
  patch: string;
  canRevert: boolean;
}
interface Changes {
  sessionId: string;
  turns: Array<{ n: number; files: FileDiff[] }>;
}
export interface ReloadStatus {
  state: 'idle' | 'reloading' | 'ok' | 'failed' | 'unavailable';
  at?: string;
  error?: string;
  stderrTail?: string;
}

export async function fetchReloadStatus(): Promise<ReloadStatus> {
  try {
    const res = await fetch('/__supervisor/status', { credentials: 'same-origin' });
    if (!res.ok) return { state: 'unavailable' };
    return (await res.json()) as ReloadStatus;
  } catch {
    return { state: 'unavailable' };
  }
}

export const useReloadStatus = () => useQuery({ queryKey: ['supervisor', 'status'], queryFn: fetchReloadStatus, refetchInterval: 4000 });

function statusTone(s: FileDiff['status']): 'ok' | 'warn' | 'danger' | 'neutral' {
  if (s === 'added') return 'ok';
  if (s === 'modified') return 'warn';
  if (s === 'deleted') return 'danger';
  return 'neutral';
}

export function ChangesPanel({ sessionId, live }: { sessionId: string | null; live: boolean }) {
  const qc = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['dev', 'changes', sessionId], queryFn: () => apiGet<Changes>(`/api/dev/changes/${sessionId}`), enabled: Boolean(sessionId), refetchInterval: live ? 1000 : false });
  // The turn's last writes can land after the final poll; refresh once more when the session settles.
  useEffect(() => {
    if (sessionId && !live) void qc.invalidateQueries({ queryKey: ['dev', 'changes', sessionId] });
  }, [live, sessionId, qc]);
  const confirm = useConfirm();
  const revert = async (turn: number, abs?: string) => {
    if (!sessionId) return;
    if (!(await confirm({ title: abs ? 'Revert this file?' : `Revert turn ${turn}?`, body: abs ? `${abs} goes back to its bytes before turn ${turn}.` : `Every file turn ${turn} changed goes back to its earlier bytes.`, confirmLabel: 'Revert', danger: true }))) return;
    try {
      const r = await apiSend<{ reverted: Array<{ abs: string; result: string }> }>('POST', '/api/dev/revert', { sessionId, turn, abs });
      setNote(`Reverted: ${r.reverted.map((x) => `${x.abs.split('/').pop()} (${x.result})`).join(', ') || 'nothing to revert'}`);
      await qc.invalidateQueries({ queryKey: ['dev', 'changes', sessionId] });
      await qc.invalidateQueries({ queryKey: ['config'] });
    } catch (err) {
      setNote(`Revert failed: ${describeError(err)}`);
    }
  };
  if (!sessionId) return <Empty>Changes appear here per turn once a Dev Chat session runs.</Empty>;
  const turns = q.data?.turns ?? [];
  return (
    <div className="stack" aria-label="Changes">
      {note && (
        <p role="status" className="muted small">
          {note}
        </p>
      )}
      {turns.length === 0 && <Empty>No turns yet.</Empty>}
      {turns.map((t) => (
        <div key={t.n} className="card">
          <div className="row gap" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Turn {t.n}</h2>
            <button type="button" disabled={live || t.files.every((f) => !f.canRevert)} onClick={() => void revert(t.n)}>
              Revert turn
            </button>
          </div>
          {t.files.length === 0 ? (
            <Empty>No files changed.</Empty>
          ) : (
            t.files.map((f) => (
              <details key={f.abs} className="section">
                <summary>
                  <Pill tone={statusTone(f.status)}>{f.status}</Pill> <span className="mono">{f.path}</span> <span className="faint small">{f.root === 'data' ? 'data root' : 'repo'}</span>{' '}
                  <span className="mono small" style={{ color: 'var(--success)' }}>
                    +{f.additions}
                  </span>{' '}
                  <span className="mono small" style={{ color: 'var(--danger)' }}>
                    -{f.deletions}
                  </span>
                </summary>
                {f.patch ? <pre tabIndex={0} className="log mono small">{f.patch}</pre> : <p className="muted small">No textual difference.</p>}
                <button type="button" disabled={live || !f.canRevert} onClick={() => void revert(t.n, f.abs)}>
                  Revert file
                </button>
              </details>
            ))
          )}
        </div>
      ))}
    </div>
  );
}

function GitDiff() {
  const q = useQuery({ queryKey: ['dev', 'git-diff'], queryFn: () => apiGet<{ ok: boolean; stat: string; diff: string; error: string | null }>('/api/dev/git-diff'), refetchInterval: 10_000 });
  return (
    <details className="card">
      <summary>git diff for custom/ {q.data?.stat ? <span className="faint small">({q.data.stat.trim().split('\n').at(-1)})</span> : null}</summary>
      {q.data?.error && <p className="danger-text small">{q.data.error}</p>}
      <pre tabIndex={0} className="log mono small">{q.data?.diff || 'clean'}</pre>
    </details>
  );
}

export function ReloadStatusCard() {
  const q = useReloadStatus();
  const s = q.data;
  return (
    <div className="card">
      <h2>Server reload</h2>
      {!s || s.state === 'unavailable' ? (
        <p className="muted small">Supervisor status unavailable (the server is running without the supervisor, or the status endpoint is unreachable).</p>
      ) : s.state === 'failed' ? (
        <div role="alert">
          <Pill tone="danger">reload failed</Pill> <span className="muted small">{s.error}</span>
          {s.stderrTail && <pre tabIndex={0} className="log mono small">{s.stderrTail}</pre>}
          <p className="small">
            The previous server is still serving. Revert the change below or from <a href="/__recovery">/__recovery</a>.
          </p>
        </div>
      ) : (
        <p className="muted small">
          <Pill tone={s.state === 'reloading' ? 'info' : 'ok'}>{s.state}</Pill> {s.at ? `last reload ${s.at}` : 'no reload yet; server edits trigger a blue/green restart'}
        </p>
      )}
    </div>
  );
}

export function DevChatPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState('queued');
  const [blacklist, setBlacklist] = useState(false);
  const actions = useActions();
  const { run, message } = useRunAction();
  const onStatus = useCallback((s: string) => setStatus(s), []);
  const live = sessionId !== null && !isTerminal(status);
  return (
    <section aria-labelledby="page-title">
      <div className="page-header">
        <h1 id="page-title">Dev Chat</h1>
        <div className="row gap">
          <label className="row gap small">
            <input type="checkbox" checked={blacklist} onChange={(e) => setBlacklist(e.target.checked)} /> Allow data/blacklist.md this turn
          </label>
          <ActionButton meta={actions.data?.find((a) => a.id === 'devchat.installDeps')} onRun={() => void run('devchat.installDeps', {}, 'npm install started; see Runs for its log')} />
        </div>
      </div>
      <Message message={message} />
      <p className="muted small">Scope: the user layer (cv.md, profile, portals, data/, reports/, output/, interview-prep/) and custom/**. Never the supervisor, node_modules, applications.md, or the blacklist unless you tick the box.</p>
      <div className="split">
        <SessionPanel key="devchat" mode="devchat" title="Dev Chat" placeholder="Describe the change: a new Insights tab, a fix in custom/immigration, an edit to the house rules" onStatus={onStatus} onSessionId={setSessionId} blacklistAllowed={blacklist} startLabel="Send" />
        <div className="stack">
          <ReloadStatusCard />
          <ChangesPanel sessionId={sessionId} live={live} />
          <GitDiff />
        </div>
      </div>
    </section>
  );
}

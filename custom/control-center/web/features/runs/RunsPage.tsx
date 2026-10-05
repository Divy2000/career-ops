import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiGet, apiSend } from '../../lib/api';
import { DataState, Empty, Pill, TableScroll } from '../../components/ui';
import type { ActionMeta, RawLine, RunMeta, RunStatus } from '@shared/api';
import { LogBrowser, ScheduleCards } from './ScheduleCards';
import { groupQuickActions } from './quickActions';
import { describeError } from '../../lib/actions';
import { formatLocalClock, formatLocalMinute } from '../../lib/time';

const ANSI = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*[A-Za-z]`, 'g');
export const stripAnsi = (s: string) => s.replace(ANSI, '');

function statusTone(s: RunStatus): 'ok' | 'danger' | 'warn' | 'info' | 'neutral' {
  if (s === 'done') return 'ok';
  if (s === 'failed' || s === 'lost') return 'danger';
  if (s === 'cancelled') return 'warn';
  if (s === 'running') return 'info';
  return 'neutral';
}

function LogViewer({ run }: { run: RunMeta }) {
  const [lines, setLines] = useState<RawLine[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const pre = useRef<HTMLPreElement>(null);
  // The viewer is keyed by run id, so a new run mounts a fresh instance; no state reset needed here.
  useEffect(() => {
    const es = new EventSource(`/api/runs/${run.id}/events`);
    es.addEventListener('line', (ev) => setLines((prev) => [...prev, JSON.parse((ev as MessageEvent).data) as RawLine]));
    es.addEventListener('run.done', (ev) => {
      setDone((JSON.parse((ev as MessageEvent).data) as { status: string }).status);
      es.close();
    });
    es.onerror = () => es.close();
    return () => es.close();
  }, [run.id]);
  useEffect(() => {
    pre.current?.scrollTo({ top: pre.current.scrollHeight });
  }, [lines.length]);
  return (
    <div className="card">
      <div className="row gap" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>
          {run.label} <span className="faint mono small">{run.id}</span>
        </h2>
        <span className="faint small">{done ? `ended: ${done}` : run.status === 'running' ? 'live' : run.status}</span>
      </div>
      <pre ref={pre} className="log" aria-live="polite" aria-label="Run log" tabIndex={0}>
        {lines.length === 0 ? <span className="faint">No output yet.</span> : lines.map((l) => (
          <div key={l.seq} className={l.stream === 'stderr' ? 'log__err' : ''}>
            <span className="faint">{formatLocalClock(l.ts)} </span>
            {stripAnsi(l.line)}
          </div>
        ))}
      </pre>
    </div>
  );
}

export function RunsPage() {
  const qc = useQueryClient();
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => apiGet<RunMeta[]>('/api/runs'), refetchInterval: 2000 });
  const actions = useQuery({ queryKey: ['actions'], queryFn: () => apiGet<ActionMeta[]>('/api/actions') });
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const current = runs.data?.find((r) => r.id === selected) ?? null;
  const quick = (actions.data ?? []).filter((a) => !a.sync && !a.confirm && Object.keys((a.params.properties as object) ?? {}).length === 0);
  const groups = groupQuickActions(quick);

  const launch = async (id: string) => {
    try {
      const r = await apiSend<{ runId: string }>('POST', `/api/actions/${id}`, { params: {} });
      setSelected(r.runId);
      setMessage(null);
      await qc.invalidateQueries({ queryKey: ['runs'] });
    } catch (err) {
      setMessage(`Could not start ${id}: ${(err as Error).message}`);
    }
  };
  const cancel = async (id: string) => {
    try {
      await apiSend('POST', `/api/runs/${id}/cancel`);
      setMessage(null);
    } catch (err) {
      // Also a toast: the page message sits above a run table the Cancel button may be scrolled far down.
      const text = `Could not cancel ${id}: ${describeError(err)}`;
      setMessage(text);
      toast.error(text);
    }
    await qc.invalidateQueries({ queryKey: ['runs'] });
  };

  return (
    <section aria-labelledby="page-title">
      <div className="page-header">
        <h1 id="page-title">Runs & Schedule</h1>
      </div>
      {groups.length > 0 && (
        <div className="card quick-runs" aria-labelledby="quick-runs-heading">
          <h2 id="quick-runs-heading">Run a script</h2>
          {groups.map((g) => (
            <div key={g.label} className="quick-runs__group" role="group" aria-label={g.label}>
              <span className="quick-runs__label muted small">{g.label}</span>
              <div className="quick-runs__buttons">
                {g.actions.map((a) => (
                  <button key={a.id} type="button" onClick={() => void launch(a.id)} title={`Cost: ${a.cost}`}>
                    Run {a.label} <Pill>{a.cost}</Pill>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {message && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {message}
        </p>
      )}
      <div className="split">
        <DataState query={runs}>
          {runs.data && runs.data.length === 0 ? (
            <Empty>No runs yet. Start one from the buttons above or from any page action.</Empty>
          ) : (
            <TableScroll label="Runs">
              <table className="table table--interactive">
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col">Action</th>
                    <th scope="col">Started</th>
                    <th scope="col">Exit</th>
                    <th scope="col">
                      <span className="sr-only">Controls</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(runs.data ?? []).map((r) => (
                    <tr key={r.id} className={r.id === selected ? 'is-selected' : ''} onClick={() => setSelected(r.id)} aria-selected={r.id === selected}>
                      <td>
                        <Pill tone={statusTone(r.status)}>{r.status}</Pill>
                      </td>
                      <td>
                        {r.label} <span className="faint mono small">{r.actionId}</span>
                      </td>
                      <td className="mono muted">{formatLocalMinute(r.startedAt ?? r.createdAt)}</td>
                      <td className="mono">{r.exitCode ?? ''}</td>
                      <td>
                        {(r.status === 'running' || r.status === 'queued') && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void cancel(r.id);
                            }}
                          >
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
        </DataState>
        <div className="stack">
          {current ? <LogViewer key={current.id} run={current} /> : <div className="card"><Empty>Select a run to see its log.</Empty></div>}
          <ScheduleCards />
          <LogBrowser />
        </div>
      </div>
    </section>
  );
}

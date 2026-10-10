import { useEffect, useMemo, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useWhatsNew } from '../../lib/queries';
import { ApiError, apiGet, apiSend } from '../../lib/api';
import { describeError, useActions, useRunAction } from '../../lib/actions';
import { ActionButton, Message } from '../../components/ActionBar';
import { DataState, Empty, Pill, Tabs, TableScroll } from '../../components/ui';
import { AiSearchTab } from './AiSearchTab';
import { addNote } from './addNote';
import { ModeLauncher } from '../../components/ModeLauncher';
import { lastSession } from '../../lib/lastSession';
import type { RawLine } from '@shared/api';
import { pipelineAddBatches } from '@shared/pipeline-add';
import { NETWORK_SCAN_SOURCES, type NetworkScanSource } from '@shared/network-scan';

const route = getRouteApi('/discover');
export type DiscoverTab = 'network' | 'portal' | 'ai' | 'fresh' | 'funded' | 'reposts';

export interface ScanPosting {
  url: string;
  company: string;
  title: string;
  location?: string | null;
  postedAt?: string | null;
  source?: string;
}

export interface ScanSummary {
  postings: ScanPosting[];
  capHit?: boolean;
  stoppedEarly?: boolean;
  /** Per source: 'ok', 'stale' (an expired cached company list) or 'empty' (no company list at all). */
  datasetStatus?: Record<string, string>;
  companiesScanned?: number;
  companiesAvailable?: number;
  unreachableBoards?: number;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
function statusRecord(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

/** scan-ats-full --json prints one JSON object on stdout; progress goes to stderr. A SIGTERM partial says stoppedEarly, a DNS-outage stop says stoppedByOutage. */
export function parseScanOutput(lines: RawLine[]): ScanSummary | null {
  for (const l of [...lines].reverse()) {
    if (l.stream !== 'stdout' || !l.line.trim().startsWith('{')) continue;
    try {
      const obj = JSON.parse(l.line) as Record<string, unknown>;
      const list = (obj.postings ?? obj.offers ?? obj.results ?? []) as ScanPosting[];
      return { postings: Array.isArray(list) ? list : [], capHit: Boolean(obj.capHit), stoppedEarly: Boolean(obj.stoppedEarly || obj.stoppedByOutage), datasetStatus: statusRecord(obj.datasetStatus), companiesScanned: num(obj.companiesScanned), companiesAvailable: num(obj.companiesAvailable), unreachableBoards: num(obj.unreachableBoards) };
    } catch {
      /* not the summary line */
    }
  }
  return null;
}

export function DiscoverPage() {
  const { tab } = route.useSearch();
  const navigate = useNavigate({ from: '/discover' });
  const setTab = (t: DiscoverTab) => void navigate({ search: { tab: t } });
  return (
    <section aria-labelledby="page-title">
      <div className="page-header">
        <h1 id="page-title">Discover</h1>
      </div>
      <Tabs
        label="Discover sections"
        tabs={[
          { id: 'network', label: 'Network scan' },
          { id: 'portal', label: 'Portal scan' },
          { id: 'ai', label: 'AI search' },
          { id: 'fresh', label: 'Fresh' },
          { id: 'funded', label: 'Funded' },
          { id: 'reposts', label: 'Reposts' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'network' && <NetworkScan />}
      {tab === 'portal' && <ScriptTab id="scan.portals" intro="Scans every enabled portal in portals.yml and appends new postings to the pipeline." params={{ verify: false, includeBlacklisted: false }} />}
      {tab === 'ai' && (
        <div className="stack">
          <AiSearchTab />
          <ModeLauncher
            heading="AI scan modes"
            rememberAs="cc.discover.modes"
            modes={[
              { id: 'scan', label: 'AI portal scan', prompt: 'Scan the configured portals with judgment and add strong matches to the pipeline.' },
              { id: 'discover', label: 'Discover ATS boards', prompt: 'Find the ATS boards for these companies and append them to portals.yml: ' },
            ]}
          />
        </div>
      )}
      {tab === 'fresh' && <Fresh />}
      {tab === 'funded' && <ScriptTab id="scan.funded" intro="Recently funded companies from public sources, dry run only." params={{ months: 6 }} />}
      {tab === 'reposts' && <ScriptTab id="scan.reposts" intro="Postings that reappeared after being taken down." params={{}} />}
    </section>
  );
}

export function ScriptTab({ id, intro, params }: { id: string; intro: string; params: Record<string, unknown> }) {
  const actions = useActions();
  const { run, busy, message } = useRunAction();
  const [runId, setRunId] = useState<string | null>(null);
  return (
    <div className="card stack">
      <p className="muted">{intro}</p>
      <div className="row gap">
        <ActionButton
          meta={actions.data?.find((a) => a.id === id)}
          disabled={busy !== null}
          params={params}
          onRun={(p) =>
            void run(id, p).then((out) => {
              if (out && 'runId' in out) setRunId(out.runId);
            })
          }
        />
      </div>
      <Message message={message} />
      {runId && <RunTail runId={runId} />}
    </div>
  );
}

interface RunTailState {
  runId: string | null;
  lines: RawLine[];
  status: string | null;
}

/** A run the server no longer has (deleted, or another data root since a restart): its stream answers 404. */
const RUN_GONE = 'gone';

/** Tails a run's SSE stream; state is keyed by run id so a new run starts from an empty log. */
function useRunLines(runId: string | null) {
  const [state, setState] = useState<RunTailState>({ runId: null, lines: [], status: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!runId) return;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const es = new EventSource(`/api/runs/${runId}/events`);
    const forRun = (update: (prev: RunTailState) => RunTailState) => setState((prev) => update(prev.runId === runId ? prev : { runId, lines: [], status: null }));
    es.addEventListener('line', (ev) => {
      const line = JSON.parse((ev as MessageEvent).data) as RawLine;
      forRun((prev) => (prev.lines.some((l) => l.seq === line.seq) ? prev : { ...prev, lines: [...prev.lines, line] }));
    });
    es.addEventListener('run.done', (ev) => {
      forRun((prev) => ({ ...prev, status: (JSON.parse((ev as MessageEvent).data) as { status: string }).status }));
      es.close();
    });
    // No close on error: the browser reconnects with Last-Event-ID and the server replays the lines after it, so a
    // dropped stream (a server reload, a laptop waking up) still ends with the scan's results. It gives up only when the
    // answer is not an event stream (2 is EventSource.CLOSED): a 404 means the run is gone, anything else is tried again.
    es.addEventListener('error', () => {
      if (es.readyState !== 2) return;
      const again = () => {
        if (!disposed) retry = setTimeout(() => setAttempt((n) => n + 1), 2000);
      };
      apiGet(`/api/runs/${runId}`).then(again, (err: unknown) => {
        if (disposed) return;
        if (err instanceof ApiError && err.status === 404) forRun((prev) => ({ ...prev, status: RUN_GONE }));
        else again();
      });
    });
    return () => {
      disposed = true;
      clearTimeout(retry);
      es.close();
    };
  }, [runId, attempt]);
  return state.runId === runId ? { lines: state.lines, status: state.status } : { lines: [], status: null };
}

function RunTail({ runId }: { runId: string }) {
  return <RunLog {...useRunLines(runId)} />;
}

/** A run's log from lines its host already follows: a second stream for the same run would hold another connection. */
function RunLog({ lines, status }: { lines: RawLine[]; status: string | null }) {
  return (
    <pre className="log" aria-live="polite" aria-label="Scan log" tabIndex={0}>
      {lines.slice(-200).map((l) => (
        <div key={l.seq} className={l.stream === 'stderr' ? 'log__err' : ''}>
          {l.line}
        </div>
      ))}
      {status && <div className="faint">{status === RUN_GONE ? 'This run is no longer on the server.' : `ended: ${status}`}</div>}
    </pre>
  );
}

/** Why a finished scan saw fewer postings than its filters allow: missing or expired company lists, unreachable boards. */
function scanDegradations(summary: ScanSummary): { notes: string[]; noData: boolean } {
  const sources = Object.entries(summary.datasetStatus ?? {});
  const empty = sources.filter(([, st]) => st === 'empty').map(([name]) => name);
  const stale = sources.filter(([, st]) => st === 'stale').map(([name]) => name);
  const notes: string[] = [];
  if (empty.length) notes.push(`Degraded: the scan could not load the company list for ${empty.join(', ')}, so it checked no boards there. Check the network and run it again.`);
  if (stale.length) notes.push(`Degraded: the scan used an expired cached company list for ${stale.join(', ')}, since the download failed.`);
  const unreachable = summary.unreachableBoards ?? 0;
  if (unreachable > 0) notes.push(`${unreachable} ${unreachable === 1 ? 'board' : 'boards'} could not be reached.`);
  return { notes, noData: empty.length > 0 || summary.companiesAvailable === 0 };
}

// The last network scan this browser tab ran: leaving the tab or the page and coming back follows it again.
const networkRun = lastSession('cc.discover.networkScan');

export function NetworkScan() {
  const actions = useActions();
  const qc = useQueryClient();
  const { run, busy, message, setMessage } = useRunAction();
  const [roles, setRoles] = useState('backend, platform');
  const [exclude, setExclude] = useState('intern');
  const [locations, setLocations] = useState('Remote');
  const [sinceDays, setSinceDays] = useState<1 | 3 | 7 | 14 | 30>(7);
  const [ats, setAts] = useState<NetworkScanSource[]>(['greenhouse', 'lever']);
  const [limit, setLimit] = useState(100);
  const [runId, setRunIdState] = useState<string | null>(networkRun.read);
  const setRunId = (id: string) => {
    networkRun.write(id);
    setRunIdState(id);
  };
  const [filter, setFilter] = useState('');
  const { lines, status } = useRunLines(runId);
  useEffect(() => {
    // Nothing to follow: the results card goes, and the run is not re-attached next time.
    if (status !== RUN_GONE) return;
    networkRun.write(null);
    setRunIdState(null);
  }, [status]);
  const summary = useMemo(() => parseScanOutput(lines), [lines]);
  const split = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const start = () =>
    void run('scan.network', { roles: split(roles), exclude: split(exclude), locationAllow: split(locations), block: [], sinceDays, ats, limit }, 'Network scan started').then((out) => {
      if (out && 'runId' in out) setRunId(out.runId);
    });
  const add = async (postings: ScanPosting[]) => {
    let added = 0;
    let skipped = 0;
    try {
      // The route skips postings the pipeline already lists, so a retry after a partial failure adds nothing twice.
      for (const body of pipelineAddBatches(postings)) {
        const r = await apiSend<{ added: number; skipped: number }>('POST', '/api/pipeline/add', body);
        added += r.added;
        skipped += r.skipped;
      }
      setMessage({ tone: 'ok', text: addNote(added, skipped) });
    } catch (err) {
      setMessage({ tone: 'danger', text: `${added ? `Added ${added}, then could not add the rest` : 'Could not add'}: ${describeError(err)}` });
    }
    await qc.invalidateQueries({ queryKey: ['pipeline'] });
  };
  const degraded = summary ? scanDegradations(summary) : { notes: [], noData: false };
  const visible = (summary?.postings ?? []).filter((p) => !filter || `${p.company} ${p.title} ${p.location ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="stack">
      <form
        className="card stack"
        aria-label="Network scan filters"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <div className="row gap">
          <label>
            <span className="muted">Roles</span> <input aria-label="Roles (comma separated)" value={roles} onChange={(e) => setRoles(e.target.value)} />
          </label>
          <label>
            <span className="muted">Exclude</span> <input aria-label="Exclude keywords" value={exclude} onChange={(e) => setExclude(e.target.value)} />
          </label>
          <label>
            <span className="muted">Locations</span> <input aria-label="Allowed locations" value={locations} onChange={(e) => setLocations(e.target.value)} />
          </label>
          <label>
            <span className="muted">Posted within</span>{' '}
            <select aria-label="Posted window" value={sinceDays} onChange={(e) => setSinceDays(Number(e.target.value) as typeof sinceDays)}>
              {[1, 3, 7, 14, 30].map((d) => (
                <option key={d} value={d}>
                  {d}d
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="muted">Depth</span>{' '}
            <select aria-label="Scan depth" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {[50, 100, 200, 500].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="row gap" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="muted">ATS sources</legend>
          {NETWORK_SCAN_SOURCES.map((a) => (
            <label key={a} className="row gap">
              <input type="checkbox" checked={ats.includes(a)} onChange={(e) => setAts(e.target.checked ? [...ats, a] : ats.filter((x) => x !== a))} /> {a}
            </label>
          ))}
        </fieldset>
        <div className="row gap">
          <button type="submit" disabled={ats.length === 0 || actions.isPending || busy !== null}>
            Run network scan <Pill tone="info">Network</Pill>
          </button>
          <span className="faint">Dry run: nothing is written until you add results.</span>
        </div>
        <Message message={message} />
      </form>
      {runId && (
        <div className="card stack">
          <div className="row gap" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Results</h2>
            <span className="faint">{status ? `scan ${status}` : 'scanning'}</span>
          </div>
          {summary?.capHit && <p className="muted">Capped: the depth limit stopped the sweep early. Raise the depth to see more.</p>}
          {summary?.stoppedEarly && <p className="muted">Degraded: the scan stopped before finishing its sources.</p>}
          {degraded.notes.map((note) => (
            <p key={note} className="muted">
              {note}
            </p>
          ))}
          {status === 'failed' && (
            <p role="alert" className="danger-text">
              The scan failed. See the log below and the run on Runs & Schedule.
            </p>
          )}
          {summary && summary.postings.length === 0 && status === 'done' && !degraded.noData && <Empty>No postings matched these filters.</Empty>}
          {summary && summary.postings.length > 0 && (
            <>
              <div className="toolbar">
                <input type="search" aria-label="Filter results" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
                <button type="button" onClick={() => void add(visible)}>
                  Add all ({visible.length})
                </button>
              </div>
              <TableScroll label="Network scan results">
                <table className="table" aria-label="Network scan results">
                  <thead>
                    <tr>
                      <th scope="col">Company</th>
                      <th scope="col">Role</th>
                      <th scope="col">Location</th>
                      <th scope="col">Posted</th>
                      <th scope="col">Source</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((p) => (
                      <tr key={p.url}>
                        <td>{p.company}</td>
                        <td>
                          <a href={p.url} target="_blank" rel="noreferrer noopener">
                            {p.title}
                          </a>
                        </td>
                        <td className="muted">{p.location ?? ''}</td>
                        <td className="mono muted">{p.postedAt ?? ''}</td>
                        <td>
                          <Pill>{p.source ?? ''}</Pill>
                        </td>
                        <td>
                          <button type="button" aria-label={`Add ${p.company} ${p.title}`} onClick={() => void add([p])}>
                            Add
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </>
          )}
          <RunLog lines={lines} status={status} />
        </div>
      )}
    </div>
  );
}

function Fresh() {
  const q = useWhatsNew(7, 50);
  return (
    <DataState query={q}>
      {q.data && q.data.offers.length === 0 ? (
        <Empty>No fresh matches this week. Run a portal or network scan.</Empty>
      ) : (
        <TableScroll label="Fresh matches">
          <table className="table" aria-label="Fresh matches">
            <thead>
              <tr>
                <th scope="col">Company</th>
                <th scope="col">Role</th>
                <th scope="col">First seen</th>
              </tr>
            </thead>
            <tbody>
              {q.data?.offers.map((o) => (
                <tr key={o.url}>
                  <td>{o.company}</td>
                  <td>
                    <a href={o.url} target="_blank" rel="noreferrer noopener">
                      {o.title}
                    </a>
                  </td>
                  <td className="mono muted">{o.firstSeen}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </DataState>
  );
}

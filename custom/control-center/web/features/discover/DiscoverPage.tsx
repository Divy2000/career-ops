import { useEffect, useMemo, useRef, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useWhatsNew } from '../../lib/queries';
import { ApiError, apiGet, apiSend } from '../../lib/api';
import { describeError, useActions, useRunAction } from '../../lib/actions';
import { ActionButton, Message } from '../../components/ActionBar';
import { DataState, Empty, Pill, Tabs, TableScroll } from '../../components/ui';
import { AiSearchTab } from './AiSearchTab';
import { addNote } from './addNote';
import { PostingLink } from './PostingLink';
import { ModeLauncher } from '../../components/ModeLauncher';
import { lastSession } from '../../lib/lastSession';
import type { RawLine } from '@shared/api';
import { pipelineAddBatches } from '@shared/pipeline-add';
import { postingUrl } from '@shared/posting-url';
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
  // The running run's id is remembered per action id (this browser tab), so switching tabs and coming back follows the
  // same run instead of showing an idle button and letting a second scan be queued behind the first.
  const store = useMemo(() => lastSession(`cc.discover.script.${id}`), [id]);
  const [runId, setRunIdState] = useState<string | null>(store.read);
  const setRunId = (rid: string) => {
    store.write(rid);
    setRunIdState(rid);
  };
  const { lines, status } = useRunLines(runId);
  // Nothing to follow: the log goes, and the run is not re-attached next time.
  const gone = status === RUN_GONE;
  useEffect(() => {
    if (gone) store.write(null);
  }, [gone, store]);
  return (
    <div className="card stack">
      <p className="muted">{intro}</p>
      <div className="row gap">
        <ActionButton
          meta={actions.data?.find((a) => a.id === id)}
          disabled={busy !== null || (runId !== null && status === null)}
          params={params}
          onRun={(p) =>
            void run(id, p).then((out) => {
              if (out && 'runId' in out) setRunId(out.runId);
            })
          }
        />
      </div>
      <Message message={message} />
      {runId && !gone && <RunLog lines={lines} status={status} />}
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
  // A scan stopped before it finished (a DNS outage) found no reliable "no matches", so the empty state is withheld.
  return { notes, noData: empty.length > 0 || summary.companiesAvailable === 0 || summary.stoppedEarly === true };
}

// The last network scan this browser tab ran: leaving the tab or the page and coming back follows it again.
const networkRun = lastSession('cc.discover.networkScan');

const SINCE_DAYS = [1, 3, 7, 14, 30] as const;
const DEPTHS = [50, 100, 200, 500] as const;
interface NetworkFilters {
  roles: string;
  exclude: string;
  locations: string;
  sinceDays: (typeof SINCE_DAYS)[number];
  ats: NetworkScanSource[];
  limit: number;
}
const DEFAULT_FILTERS: NetworkFilters = { roles: 'backend, platform', exclude: 'intern', locations: 'Remote', sinceDays: 7, ats: ['greenhouse', 'lever'], limit: 100 };

// The filters the remembered run used, kept beside its id: a re-attached results card must sit under the form it ran.
const NETWORK_FILTERS_KEY = 'cc.discover.networkScan.params';
/** A stored or server-side filter record, field by field: a malformed field takes its default. */
function filtersFrom(raw: unknown): NetworkFilters | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const text = (x: unknown, fallback: string) => (typeof x === 'string' ? x : fallback);
  const ats = Array.isArray(v.ats) && v.ats.length > 0 && new Set(v.ats).size === v.ats.length && v.ats.every((a) => (NETWORK_SCAN_SOURCES as readonly unknown[]).includes(a)) ? (v.ats as NetworkScanSource[]) : DEFAULT_FILTERS.ats;
  return {
    roles: text(v.roles, DEFAULT_FILTERS.roles),
    exclude: text(v.exclude, DEFAULT_FILTERS.exclude),
    locations: text(v.locations, DEFAULT_FILTERS.locations),
    sinceDays: SINCE_DAYS.find((d) => d === v.sinceDays) ?? DEFAULT_FILTERS.sinceDays,
    ats,
    limit: DEPTHS.find((d) => d === v.limit) ?? DEFAULT_FILTERS.limit,
  };
}
function readRunFilters(): NetworkFilters | null {
  if (networkRun.read() === null) return null;
  try {
    return filtersFrom(JSON.parse(sessionStorage.getItem(NETWORK_FILTERS_KEY) ?? 'null'));
  } catch {
    return null;
  }
}
/** The scan.network params the server ran a run with, in the form's terms (lists back to comma-separated text). */
function filtersFromRunParams(params: unknown): NetworkFilters | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const p = params as Record<string, unknown>;
  const list = (x: unknown) => (Array.isArray(x) && x.every((s) => typeof s === 'string') ? x.join(', ') : undefined);
  return filtersFrom({ roles: list(p.roles), exclude: list(p.exclude), locations: list(p.locationAllow), sinceDays: p.sinceDays, ats: p.ats, limit: p.limit });
}
function writeRunFilters(filters: NetworkFilters | null): void {
  try {
    if (filters) sessionStorage.setItem(NETWORK_FILTERS_KEY, JSON.stringify(filters));
    else sessionStorage.removeItem(NETWORK_FILTERS_KEY);
  } catch {
    // storage refused: a re-attached run only shows the default filters
  }
}

export function NetworkScan() {
  const actions = useActions();
  const qc = useQueryClient();
  const { run, busy, message, setMessage } = useRunAction();
  const [stored] = useState(readRunFilters);
  const initial = stored ?? DEFAULT_FILTERS;
  const [roles, setRoles] = useState(initial.roles);
  const [exclude, setExclude] = useState(initial.exclude);
  const [locations, setLocations] = useState(initial.locations);
  const [sinceDays, setSinceDays] = useState(initial.sinceDays);
  const [ats, setAts] = useState(initial.ats);
  const [limit, setLimit] = useState(initial.limit);
  const [runId, setRunIdState] = useState<string | null>(networkRun.read);
  const setRunId = (id: string, filters: NetworkFilters) => {
    writeRunFilters(filters);
    networkRun.write(id);
    setRunIdState(id);
  };
  // A run remembered without its filters (an older page started it) takes them from the run itself, unless the form
  // was edited or submitted first.
  const edited = useRef(false);
  const [initialRunId] = useState(runId);
  useEffect(() => {
    if (stored || !initialRunId) return;
    let disposed = false;
    apiGet<{ meta?: { params?: unknown } }>(`/api/runs/${initialRunId}`).then(
      (r) => {
        const f = filtersFromRunParams(r.meta?.params);
        if (disposed || edited.current || !f) return;
        writeRunFilters(f);
        setRoles(f.roles);
        setExclude(f.exclude);
        setLocations(f.locations);
        setSinceDays(f.sinceDays);
        setAts(f.ats);
        setLimit(f.limit);
      },
      () => {
        // the run's own stream reports a run the server no longer has; the form keeps its defaults
      },
    );
    return () => {
      disposed = true;
    };
  }, [stored, initialRunId]);
  const [filter, setFilter] = useState('');
  const { lines, status } = useRunLines(runId);
  // Nothing to follow: the results card goes, and the run is not re-attached next time.
  const gone = status === RUN_GONE;
  useEffect(() => {
    if (!gone) return;
    networkRun.write(null);
    writeRunFilters(null);
  }, [gone]);
  const summary = useMemo(() => parseScanOutput(lines), [lines]);
  // The remembered run is still going: a second sweep would replace it on the page while it keeps running.
  const running = runId !== null && status === null;
  const split = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const start = () => {
    if (running) return;
    // The form now belongs to this run: a late answer about the older run must not overwrite it.
    edited.current = true;
    const filters: NetworkFilters = { roles, exclude, locations, sinceDays, ats, limit };
    void run('scan.network', { roles: split(roles), exclude: split(exclude), locationAllow: split(locations), block: [], sinceDays, ats, limit }, 'Network scan started').then((out) => {
      if (out && 'runId' in out) setRunId(out.runId, filters);
    });
  };
  // One add at a time: a second click before the first answers would send the same postings and relabel them.
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false);
  const add = async (postings: ScanPosting[]) => {
    if (addingRef.current) return;
    addingRef.current = true;
    setAdding(true);
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
    try {
      await qc.invalidateQueries({ queryKey: ['pipeline'] });
    } finally {
      addingRef.current = false;
      setAdding(false);
    }
  };
  const degraded = summary ? scanDegradations(summary) : { notes: [], noData: false };
  const visible = (summary?.postings ?? []).filter((p) => !filter || `${p.company} ${p.title} ${p.location ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  // One URL POST /api/pipeline/add refuses fails the whole body, so such a posting is never sent.
  const addable = visible.filter((p) => postingUrl(p.url) !== null);
  return (
    <div className="stack">
      <form
        className="card stack"
        aria-label="Network scan filters"
        onChange={() => (edited.current = true)}
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
              {SINCE_DAYS.map((d) => (
                <option key={d} value={d}>
                  {d}d
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="muted">Depth</span>{' '}
            <select aria-label="Scan depth" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {DEPTHS.map((d) => (
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
          <button type="submit" disabled={ats.length === 0 || actions.isPending || busy !== null || running}>
            Run network scan <Pill tone="info">Network</Pill>
          </button>
          <span className="faint">Dry run: nothing is written until you add results.</span>
        </div>
        <Message message={message} />
      </form>
      {runId && !gone && (
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
                <button type="button" disabled={adding || addable.length === 0} onClick={() => void add(addable)}>
                  Add all ({addable.length})
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
                          <PostingLink url={p.url}>{p.title}</PostingLink>
                        </td>
                        <td className="muted">{p.location ?? ''}</td>
                        <td className="mono muted">{p.postedAt ?? ''}</td>
                        <td>
                          <Pill>{p.source ?? ''}</Pill>
                        </td>
                        <td>
                          {postingUrl(p.url) === null ? (
                            <Pill tone="warn">not a posting URL</Pill>
                          ) : (
                            <button type="button" aria-label={`Add ${p.company} ${p.title}`} disabled={adding} onClick={() => void add([p])}>
                              Add
                            </button>
                          )}
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

export function Fresh() {
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
                    <PostingLink url={o.url}>{o.title}</PostingLink>
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

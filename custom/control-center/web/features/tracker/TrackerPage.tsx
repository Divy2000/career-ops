import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { useTracker } from '../../lib/queries';
import { DataState, Empty, ScorePill, StatusPill, Tabs } from '../../components/ui';
import { StatusControl } from './StatusControl';
import type { TrackerRow } from '@shared/api';

export type TrackerTab = 'all' | 'evaluated' | 'interview' | 'responded' | 'applied' | 'top' | 'skip' | 'rejected' | 'discarded';
export type SortKey = 'num' | 'company' | 'role' | 'score' | 'status' | 'date' | 'location' | 'pay' | 'lastContact' | 'posted';
export interface TrackerSearch {
  tab: TrackerTab;
  q: string;
  sort: SortKey;
  dir: 'asc' | 'desc';
  view: 'flat' | 'grouped';
}

export const TRACKER_TABS: Array<{ id: TrackerTab; label: string; match: (r: TrackerRow) => boolean }> = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'evaluated', label: 'Evaluated', match: (r) => r.status === 'Evaluated' },
  { id: 'interview', label: 'Interview', match: (r) => r.status === 'Interview' },
  { id: 'responded', label: 'Responded', match: (r) => r.status === 'Responded' },
  { id: 'applied', label: 'Applied', match: (r) => r.status === 'Applied' },
  { id: 'top', label: 'Top 4+', match: (r) => (r.score ?? 0) >= 4 },
  { id: 'skip', label: 'Skip', match: (r) => r.status === 'SKIP' },
  { id: 'rejected', label: 'Rejected', match: (r) => r.status === 'Rejected' },
  { id: 'discarded', label: 'Discarded', match: (r) => r.status === 'Discarded' },
];

const STATUS_ORDER = ['Interview', 'Offer', 'Hired', 'Responded', 'Applied', 'Evaluated', 'Rejected', 'Discarded', 'SKIP'];

const COLUMNS: Array<{ key: SortKey; label: string; optional: boolean }> = [
  { key: 'num', label: '#', optional: false },
  { key: 'company', label: 'Company', optional: false },
  { key: 'role', label: 'Role', optional: false },
  { key: 'score', label: 'Score', optional: false },
  { key: 'status', label: 'Status', optional: false },
  { key: 'date', label: 'Date', optional: true },
  { key: 'location', label: 'Location', optional: true },
  { key: 'pay', label: 'Pay', optional: true },
  { key: 'lastContact', label: 'Last contact', optional: true },
  { key: 'posted', label: 'Posted', optional: true },
];

function cell(r: TrackerRow, key: SortKey): string | number | null {
  switch (key) {
    case 'num':
      return r.num;
    case 'company':
      return r.company;
    case 'role':
      return r.role;
    case 'score':
      return r.score;
    case 'status':
      return STATUS_ORDER.indexOf(r.status);
    case 'date':
      return r.date;
    case 'location':
      return r.location ?? r.summary?.remote ?? '';
    case 'pay':
      return r.summary?.comp ?? '';
    case 'lastContact':
      return r.lastContact ?? '';
    case 'posted':
      return r.posted ?? '';
  }
}

export function sortRows(rows: TrackerRow[], sort: SortKey, dir: 'asc' | 'desc'): TrackerRow[] {
  const m = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = cell(a, sort);
    const y = cell(b, sort);
    if (x === y) return a.num - b.num;
    if (x === null || x === '') return 1;
    if (y === null || y === '') return -1;
    return (x < y ? -1 : 1) * m;
  });
}

export function filterRows(rows: TrackerRow[], tab: TrackerTab, q: string): TrackerRow[] {
  const match = TRACKER_TABS.find((t) => t.id === tab)?.match ?? (() => true);
  const needle = q.trim().toLowerCase();
  return rows.filter((r) => match(r) && (!needle || `${r.company} ${r.role} ${r.notes}`.toLowerCase().includes(needle)));
}

const route = getRouteApi('/tracker');
const COLS_KEY = 'cc.tracker.cols';

function loadCols(): Set<SortKey> {
  try {
    const raw = localStorage.getItem(COLS_KEY);
    if (raw) return new Set(JSON.parse(raw) as SortKey[]);
  } catch {
    /* private window or blocked storage: fall through to defaults */
  }
  return new Set<SortKey>(['date', 'location']);
}

import { AskTrackerPanel } from './AskTrackerPanel';

export function TrackerPage() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: '/tracker' });
  const q = useTracker();
  const [selected, setSelected] = useState<number | null>(null);
  const [cols, setCols] = useState<Set<SortKey>>(loadCols);
  const [help, setHelp] = useState(false);
  const go = useNavigate();

  useEffect(() => {
    try {
      localStorage.setItem(COLS_KEY, JSON.stringify([...cols]));
    } catch {
      /* best effort */
    }
  }, [cols]);

  const data = q.data;
  const rows = useMemo(() => (data?.kind === 'ok' ? data.rows : []), [data]);
  const visible = useMemo(() => sortRows(filterRows(rows, search.tab, search.q), search.sort, search.dir), [rows, search]);
  const current = visible.find((r) => r.num === selected) ?? null;
  const visibleCols = COLUMNS.filter((c) => !c.optional || cols.has(c.key));

  const update = (patch: Partial<TrackerSearch>) => void navigate({ to: '/tracker', search: (prev: TrackerSearch) => ({ ...prev, ...patch }) });
  const toggleSort = (key: SortKey) => update({ sort: key, dir: search.sort === key && search.dir === 'asc' ? 'desc' : 'asc' });

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const idx = visible.findIndex((r) => r.num === selected);
    const pick = (i: number) => setSelected(visible[Math.max(0, Math.min(visible.length - 1, i))]?.num ?? null);
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        pick(idx + 1);
        break;
      case 'k':
      case 'ArrowUp':
        pick(idx - 1);
        break;
      case 'g':
        pick(0);
        break;
      case 'G':
        pick(visible.length - 1);
        break;
      case 'Enter':
        if (current) void go({ to: '/tracker/$n', params: { n: String(current.num) } });
        break;
      case 'o':
        if (current?.url) window.open(current.url, '_blank', 'noopener');
        break;
      case '/':
        e.preventDefault();
        document.getElementById('tracker-search')?.focus();
        break;
      case 'v':
        update({ view: search.view === 'flat' ? 'grouped' : 'flat' });
        break;
      case '?':
        setHelp((h) => !h);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const groups = search.view === 'grouped' ? STATUS_ORDER.map((s) => ({ status: s, rows: visible.filter((r) => r.status === s) })).filter((g) => g.rows.length) : [{ status: null, rows: visible }];

  return (
    <section aria-labelledby="page-title">
      <div className="page-header">
        <h1 id="page-title">Tracker</h1>
        <span className="faint">
          {visible.length} of {rows.length} rows. Press ? for keys.
        </span>
      </div>
      <AskTrackerPanel />
      <DataState query={q} missing={<span>No applications yet. Evaluate an offer to create the tracker.</span>}>
        <Tabs label="Status" tabs={TRACKER_TABS.map((t) => ({ id: t.id, label: t.label, count: rows.filter(t.match).length }))} value={search.tab} onChange={(tab) => update({ tab })} />
        <div className="toolbar">
          <input id="tracker-search" type="search" placeholder="Search company, role, notes" aria-label="Search tracker" value={search.q} onChange={(e) => update({ q: e.target.value })} />
          <button type="button" aria-pressed={search.view === 'grouped'} onClick={() => update({ view: search.view === 'flat' ? 'grouped' : 'flat' })}>
            {search.view === 'grouped' ? 'Grouped by status' : 'Flat list'}
          </button>
          <details className="menu">
            <summary>Columns</summary>
            <div className="menu__body">
              {COLUMNS.filter((c) => c.optional).map((c) => (
                <label key={c.key} className="row gap">
                  <input
                    type="checkbox"
                    checked={cols.has(c.key)}
                    onChange={(e) => {
                      const next = new Set(cols);
                      if (e.target.checked) next.add(c.key);
                      else next.delete(c.key);
                      setCols(next);
                    }}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          </details>
        </div>
        <div className="split">
          <div className="table-wrap" tabIndex={0} onKeyDown={onKey} aria-label="Tracker rows, use j and k to move">
            {visible.length === 0 ? (
              <Empty>No rows match. Clear the search or pick another tab.</Empty>
            ) : (
              <table className="table table--interactive">
                <thead>
                  <tr>
                    {visibleCols.map((c) => (
                      <th key={c.key} scope="col" aria-sort={search.sort === c.key ? (search.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                        <button type="button" className="th-button" onClick={() => toggleSort(c.key)}>
                          {c.label}
                          {search.sort === c.key ? (search.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                        </button>
                      </th>
                    ))}
                    <th scope="col">
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <GroupRows key={g.status ?? 'all'} status={g.status} rows={g.rows} cols={visibleCols} selected={selected} onSelect={setSelected} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <aside className="preview card" aria-label="Preview">
            {current ? (
              <>
                <h2>{current.company}</h2>
                <p className="muted">{current.role}</p>
                <div className="row gap">
                  <ScorePill score={current.score} />
                  <StatusPill status={current.status} />
                </div>
                <div style={{ marginTop: 12 }}>
                  <StatusControl key={current.num} row={current} />
                </div>
                <dl className="kv" style={{ marginTop: 12 }}>
                  <dt>Archetype</dt>
                  <dd>{current.summary?.archetype ?? 'n/a'}</dd>
                  <dt>TL;DR</dt>
                  <dd>{current.summary?.tldr ?? (current.reportState === 'none' ? 'No report linked' : current.reportState === 'malformed' ? 'Report malformed' : 'n/a')}</dd>
                  <dt>Remote</dt>
                  <dd>{current.summary?.remote ?? 'n/a'}</dd>
                  <dt>Comp</dt>
                  <dd>{current.summary?.comp ?? 'n/a'}</dd>
                  <dt>Notes</dt>
                  <dd>{current.notes || 'none'}</dd>
                </dl>
                <div className="row gap" style={{ marginTop: 12 }}>
                  <Link to="/tracker/$n" params={{ n: String(current.num) }} className="button-link">
                    Open report
                  </Link>
                  {current.url && (
                    <a className="button-link" href={current.url} target="_blank" rel="noreferrer noopener">
                      Open posting
                    </a>
                  )}
                </div>
              </>
            ) : (
              <Empty>Select a row (click or j/k) to preview it.</Empty>
            )}
          </aside>
        </div>
        {help && (
          <div className="card help" role="dialog" aria-label="Keyboard shortcuts">
            <h2>Keys</h2>
            <dl className="kv">
              <dt>j / k</dt>
              <dd>Move selection</dd>
              <dt>g / G</dt>
              <dd>First / last row</dd>
              <dt>Enter</dt>
              <dd>Open application</dd>
              <dt>o</dt>
              <dd>Open posting</dd>
              <dt>/</dt>
              <dd>Search</dd>
              <dt>v</dt>
              <dd>Toggle grouped view</dd>
              <dt>?</dt>
              <dd>Toggle this help</dd>
            </dl>
            <button type="button" onClick={() => setHelp(false)}>
              Close
            </button>
          </div>
        )}
      </DataState>
    </section>
  );
}

function GroupRows({ status, rows, cols, selected, onSelect }: { status: string | null; rows: TrackerRow[]; cols: typeof COLUMNS; selected: number | null; onSelect: (n: number) => void }) {
  return (
    <>
      {status && (
        <tr className="group-row">
          <th scope="rowgroup" colSpan={cols.length + 1}>
            <StatusPill status={status} /> <span className="faint">{rows.length}</span>
          </th>
        </tr>
      )}
      {rows.map((r) => (
        <tr key={r.num} className={r.num === selected ? 'is-selected' : ''} onClick={() => onSelect(r.num)} aria-selected={r.num === selected}>
          {cols.map((c) => (
            <td key={c.key} className={c.key === 'num' || c.key === 'date' || c.key === 'posted' || c.key === 'lastContact' ? 'mono' : ''}>
              {c.key === 'score' ? <ScorePill score={r.score} /> : c.key === 'status' ? <StatusPill status={r.status} /> : String(cell(r, c.key) ?? '')}
            </td>
          ))}
          <td>
            <Link to="/tracker/$n" params={{ n: String(r.num) }} aria-label={`Open ${r.company}`}>
              Open
            </Link>
          </td>
        </tr>
      ))}
    </>
  );
}

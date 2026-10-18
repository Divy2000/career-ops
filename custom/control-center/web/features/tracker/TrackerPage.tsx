import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { useTracker } from '../../lib/queries';
import { DataState, Empty, ScorePill, StatusPill, Tabs } from '../../components/ui';
import { EmptyTracker } from '../../components/EmptyTracker';
import { rowIdentity, sameRow, StatusControl, type RowIdentity } from './StatusControl';
import { HiredDialog } from './HiredDialog';
import { AskTrackerPanel } from './AskTrackerPanel';
import { CompareSelected } from './CompareSelected';
import { postingHref } from '../../lib/posting-href';
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
    case 'status': {
      // An unknown status ranks after every known one, as the server's statusRank does.
      const i = STATUS_ORDER.indexOf(r.status);
      return i === -1 ? STATUS_ORDER.length : i;
    }
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
    // Unknown statuses share one rank: name order keeps each one together, as the grouped view does.
    if (x === y && sort === 'status' && a.status !== b.status) return (a.status < b.status ? -1 : 1) * m;
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

/** The states.yml labels in lifecycle order, then any status states.yml does not know, so every row lands in a group. */
export function statusGroups(rows: TrackerRow[]): Array<{ status: string; rows: TrackerRow[] }> {
  const unknown = [...new Set(rows.map((r) => r.status).filter((s) => !STATUS_ORDER.includes(s)))];
  return [...STATUS_ORDER, ...unknown].map((s) => ({ status: s, rows: rows.filter((r) => r.status === s) })).filter((g) => g.rows.length);
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

export function TrackerPage() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: '/tracker' });
  const q = useTracker();
  // The previewed row by number and identity: a delete elsewhere reindexes the tracker, and the preview (its open
  // Discard picker with it) follows the row the user picked, not the one that inherits its number.
  const [selected, setSelected] = useState<{ num: number; row: RowIdentity } | null>(null);
  // Each ticked number with the row it was ticked on: a delete elsewhere reindexes the tracker, and a number that now
  // holds another row is not that row's selection (Compare runs a paid session on these).
  const [checked, setChecked] = useState<Map<number, RowIdentity>>(new Map());
  const [cols, setCols] = useState<Set<SortKey>>(loadCols);
  const [help, setHelp] = useState(false);
  // Kept here, not in the preview's StatusControl: a Hired row leaves a filtered tab, and the control with it.
  const [hired, setHired] = useState<(TrackerRow & { reportLabel: string }) | null>(null);
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
  const current = selected === null ? null : (visible.find((r) => r.num === selected.num && sameRow(selected.row, r)) ?? visible.find((r) => sameRow(selected.row, r)) ?? null);
  const select = (r: TrackerRow | undefined) => setSelected(r ? { num: r.num, row: rowIdentity(r) } : null);
  const visibleCols = COLUMNS.filter((c) => !c.optional || cols.has(c.key));
  const isChecked = (r: TrackerRow) => {
    const ticked = checked.get(r.num);
    return ticked !== undefined && sameRow(ticked, r);
  };
  const checkedRows = rows.filter(isChecked);

  // The search box replaces its history entry: a push per keystroke would make Back step through every letter.
  const update = (patch: Partial<TrackerSearch>, replace = false) => void navigate({ to: '/tracker', search: (prev: TrackerSearch) => ({ ...prev, ...patch }), replace });
  const toggleSort = (key: SortKey) => update({ sort: key, dir: search.sort === key && search.dir === 'asc' ? 'desc' : 'asc' });
  const toggleChecked = (r: TrackerRow) =>
    setChecked((prev) => {
      const next = new Map(prev);
      const ticked = next.get(r.num);
      if (ticked !== undefined && sameRow(ticked, r)) next.delete(r.num);
      else next.set(r.num, rowIdentity(r));
      return next;
    });

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // A focused control inside the table (an Open link, a sort button, a checkbox) keeps its own keys: Enter there
    // activates it instead of opening the selected row.
    if (e.target !== e.currentTarget && (e.target as HTMLElement).closest('a, button, input, select, textarea, summary, [contenteditable="true"]')) return;
    const idx = current === null ? -1 : visible.indexOf(current);
    const pick = (i: number) => select(visible[Math.max(0, Math.min(visible.length - 1, i))]);
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
        if (current?.url) window.open(postingHref(current.url), '_blank', 'noopener');
        break;
      case 'x':
        if (current) toggleChecked(current);
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

  const groups = search.view === 'grouped' ? statusGroups(visible) : [{ status: null, rows: visible }];
  const allVisibleChecked = visible.length > 0 && visible.every(isChecked);

  return (
    <section aria-labelledby="page-title">
      <div className="page-header">
        <h1 id="page-title">Tracker</h1>
        <span className="faint">
          {visible.length} of {rows.length} rows. Press ? for keys.
        </span>
      </div>
      <AskTrackerPanel />
      <DataState query={q} emptyState={<EmptyTracker />}>
        {data?.kind === 'ok' && rows.length === 0 ? (
          <EmptyTracker />
        ) : (
          <>
        <Tabs label="Status" tabs={TRACKER_TABS.map((t) => ({ id: t.id, label: t.label, count: rows.filter(t.match).length }))} value={search.tab} onChange={(tab) => update({ tab })} />
        <div className="toolbar">
          <input id="tracker-search" type="search" placeholder="Search company, role, notes" aria-label="Search tracker" value={search.q} onChange={(e) => update({ q: e.target.value }, true)} />
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
        <CompareSelected rows={checkedRows} onClear={() => setChecked(new Map())} />
        <div className="split">
          <div className="table-wrap" tabIndex={0} onKeyDown={onKey} aria-label="Tracker rows, use j and k to move, x to select">
            {visible.length === 0 ? (
              <Empty>No rows match. Clear the search or pick another tab.</Empty>
            ) : (
              <table className="table table--interactive">
                <thead>
                  <tr>
                    <th scope="col">
                      <input
                        type="checkbox"
                        aria-label="Select all visible rows"
                        checked={allVisibleChecked}
                        onChange={(e) => setChecked(e.target.checked ? new Map([...checked, ...visible.map((r) => [r.num, rowIdentity(r)] as const)]) : new Map([...checked].filter(([n]) => !visible.some((r) => r.num === n))))}
                      />
                    </th>
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
                    <GroupRows key={g.status ?? 'all'} status={g.status} rows={g.rows} cols={visibleCols} selected={current?.num ?? null} onSelect={select} isChecked={isChecked} onCheck={toggleChecked} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <aside className="preview card" aria-label="Preview">
            {hired && <HiredDialog key={hired.num} report={hired.reportLabel} company={hired.company} onClose={() => setHired(null)} />}
            {current ? (
              <>
                <h2>{current.company}</h2>
                <p className="muted">{current.role}</p>
                <div className="row gap">
                  <ScorePill score={current.score} />
                  <StatusPill status={current.status} />
                </div>
                <div style={{ marginTop: 12 }}>
                  <StatusControl key={`${current.num}\0${current.company}\0${current.role}\0${current.report}`} row={current} onHired={setHired} />
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
                    <a className="button-link" href={postingHref(current.url)} target="_blank" rel="noreferrer noopener">
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
              <dt>x</dt>
              <dd>Check the row for Compare</dd>
              <dt>/</dt>
              <dd>Search</dd>
              <dt>v</dt>
              <dd>Toggle grouped view</dd>
              <dt>Cmd+K</dt>
              <dd>Command palette</dd>
              <dt>?</dt>
              <dd>Toggle this help</dd>
            </dl>
            <button type="button" onClick={() => setHelp(false)}>
              Close
            </button>
          </div>
        )}
          </>
        )}
      </DataState>
    </section>
  );
}

function GroupRows({ status, rows, cols, selected, onSelect, isChecked, onCheck }: { status: string | null; rows: TrackerRow[]; cols: typeof COLUMNS; selected: number | null; onSelect: (r: TrackerRow) => void; isChecked: (r: TrackerRow) => boolean; onCheck: (r: TrackerRow) => void }) {
  return (
    <>
      {status && (
        <tr className="group-row">
          <th scope="rowgroup" colSpan={cols.length + 2}>
            <StatusPill status={status} /> <span className="faint">{rows.length}</span>
          </th>
        </tr>
      )}
      {rows.map((r) => (
        <tr key={r.num} className={r.num === selected ? 'is-selected' : ''} onClick={() => onSelect(r)} aria-selected={r.num === selected}>
          <td onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" aria-label={`Select ${r.company}`} checked={isChecked(r)} onChange={() => onCheck(r)} />
          </td>
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

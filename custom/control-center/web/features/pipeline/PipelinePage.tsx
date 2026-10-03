import { useMemo, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { usePipeline, useShortlist } from '../../lib/queries';
import { DataState, Empty, Pill, ScorePill, SponsorPill, Tabs, alertTone } from '../../components/ui';

const route = getRouteApi('/pipeline');
export type PipelineTab = 'inbox' | 'shortlist' | 'batch';

export function PipelinePage() {
  const { tab } = route.useSearch();
  const navigate = useNavigate({ from: '/pipeline' });
  const setTab = (t: PipelineTab) => void navigate({ search: { tab: t } });
  return (
    <section aria-labelledby="page-title">
      <div className="page-header">
        <h1 id="page-title">Pipeline</h1>
      </div>
      <Tabs
        label="Pipeline sections"
        tabs={[
          { id: 'inbox', label: 'Inbox' },
          { id: 'shortlist', label: 'Shortlist' },
          { id: 'batch', label: 'Batch' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'inbox' && <Inbox />}
      {tab === 'shortlist' && <Shortlist />}
      {tab === 'batch' && (
        <div className="card">
          <Empty>The batch runner form lands with the runner phase.</Empty>
        </div>
      )}
    </section>
  );
}

function Inbox() {
  const q = usePipeline();
  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [seniority, setSeniority] = useState('');
  const [showDone, setShowDone] = useState(false);
  const data = q.data;
  const rows = useMemo(() => (data?.kind === 'ok' ? data.rows : []), [data]);
  const sources = useMemo(() => [...new Set(rows.map((r) => r.source))].sort(), [rows]);
  const seniorities = useMemo(() => [...new Set(rows.map((r) => r.seniority ?? 'unknown'))].sort(), [rows]);
  const visible = rows.filter(
    (r) =>
      (showDone || !r.done) &&
      (!source || r.source === source) &&
      (!seniority || (r.seniority ?? 'unknown') === seniority) &&
      (!text || `${r.company} ${r.role} ${r.location ?? ''}`.toLowerCase().includes(text.toLowerCase())),
  );
  return (
    <DataState query={q} missing={<span>No pipeline yet. Add URLs or run a scan from Discover.</span>}>
      <div className="toolbar">
        <input type="search" aria-label="Filter inbox" placeholder="Filter company, role, location" value={text} onChange={(e) => setText(e.target.value)} />
        <select aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">All sources</option>
          {sources.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select aria-label="Seniority" value={seniority} onChange={(e) => setSeniority(e.target.value)}>
          <option value="">All levels</option>
          {seniorities.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <label className="row gap">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show skipped
        </label>
        <span className="faint">{visible.length} rows</span>
      </div>
      {visible.length === 0 ? (
        <Empty>Nothing matches. Clear a filter or add URLs.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Rank</th>
              <th scope="col">Company</th>
              <th scope="col">Role</th>
              <th scope="col">Location</th>
              <th scope="col">Source</th>
              <th scope="col">Level</th>
              <th scope="col">First seen</th>
              <th scope="col">Posted</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.url} className={r.done ? 'is-done' : ''}>
                <td>
                  <ScorePill score={r.rank} />
                  {r.rankReason && <div className="faint small">{r.rankReason}</div>}
                </td>
                <td>{r.company}</td>
                <td>
                  <a href={r.url} target="_blank" rel="noreferrer noopener">
                    {r.role}
                  </a>
                  {r.done && <Pill>skipped</Pill>}
                </td>
                <td className="muted">{r.location ?? ''}</td>
                <td>
                  <Pill>{r.source}</Pill>
                </td>
                <td className="muted">{r.seniority ?? ''}</td>
                <td className="mono muted">{r.firstSeen ?? ''}</td>
                <td className="mono muted">{r.postedAt ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </DataState>
  );
}

function Shortlist() {
  const q = useShortlist();
  return (
    <DataState query={q} missing={<span>No shortlist yet. The daily job or a Rebuild shortlist run creates it.</span>}>
      {q.data?.kind === 'ok' && (
        <div className="stack">
          <p className="muted">{q.data.summary}</p>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Score</th>
                <th scope="col">Rank</th>
                <th scope="col">Sponsor</th>
                <th scope="col">Company</th>
                <th scope="col">Role</th>
                <th scope="col">Location</th>
                <th scope="col">Posted</th>
                <th scope="col">Why</th>
              </tr>
            </thead>
            <tbody>
              {q.data.rows.map((r) => (
                <tr key={r.rank}>
                  <td className="mono">{r.rank}</td>
                  <td>
                    <ScorePill score={r.score} />
                  </td>
                  <td className="mono">{r.relevance ?? ''}</td>
                  <td>
                    <SponsorPill tier={r.sponsor} />
                  </td>
                  <td>{r.company}</td>
                  <td>{r.url ? <a href={r.url} target="_blank" rel="noreferrer noopener">{r.role}</a> : r.role}</td>
                  <td className="muted">{r.location ?? ''}</td>
                  <td className="mono muted">{r.posted ?? ''}</td>
                  <td className="muted">{r.why ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="card">
            <h2>Excluded by company alerts</h2>
            {q.data.excluded.length === 0 ? (
              <Empty>No companies excluded.</Empty>
            ) : (
              <ul className="bullets">
                {q.data.excluded.map((e) => (
                  <li key={e.company}>
                    <strong>{e.company}</strong> <Pill tone={alertTone(e.alert)}>{e.alert}</Pill> <span className="muted">{e.headline}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </DataState>
  );
}

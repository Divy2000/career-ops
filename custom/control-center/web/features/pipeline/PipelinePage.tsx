import { useMemo, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { usePipeline, useShortlist } from '../../lib/queries';
import { apiSend } from '../../lib/api';
import { describeError, useActions, useRunAction } from '../../lib/actions';
import { ActionButton, Message } from '../../components/ActionBar';
import { DataState, Empty, Pill, ScorePill, ShortlistScore, SponsorPill, Tabs, alertTone, TableScroll } from '../../components/ui';
import { InboxAi } from './InboxAi';
import { useConfirm } from '../../components/ConfirmDialog';
import { BatchTab } from './BatchTab';

const route = getRouteApi('/pipeline');
export type PipelineTab = 'inbox' | 'shortlist' | 'batch';
export interface PipelineSearch {
  tab: PipelineTab;
  q?: string;
}

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
      {tab === 'batch' && <BatchTab onStarted={() => void navigate({ to: '/sessions' })} />}
    </section>
  );
}

function AddUrls({ onDone }: { onDone: (added: number) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const urls = text.split(/\s+/).filter(Boolean);
    if (urls.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiSend<{ added: number }>('POST', '/api/pipeline/urls', { urls });
      setText('');
      setOpen(false);
      onDone(r.added);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Add URLs
      </button>
    );
  }
  return (
    <div className="card stack" role="dialog" aria-label="Add URLs to the pipeline">
      <textarea aria-label="Posting URLs" rows={4} placeholder="One posting URL per line" value={text} onChange={(e) => setText(e.target.value)} />
      {error && (
        <p role="alert" className="danger-text">
          {error}
        </p>
      )}
      <div className="row gap">
        <button type="button" disabled={busy || !text.trim()} onClick={() => void submit()}>
          Add to pipeline
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Inbox() {
  // The filter lives in the URL, so a link (the advisor's "Filter the pipeline") can open the Inbox already filtered.
  const { q: text = '' } = route.useSearch();
  const navigate = useNavigate({ from: '/pipeline' });
  const setText = (q: string) => void navigate({ search: (prev: PipelineSearch) => ({ ...prev, q: q || undefined }), replace: true });
  const q = usePipeline();
  const qc = useQueryClient();
  const actions = useActions();
  const { run, busy, message, setMessage } = useRunAction();
  const [skipError, setSkipError] = useState<string | null>(null);
  const confirm = useConfirm();
  const skip = async (url: string, done: boolean) => {
    setSkipError(null);
    try {
      await apiSend('POST', '/api/pipeline/skip', { url, done });
      await qc.invalidateQueries({ queryKey: ['pipeline'] });
    } catch (err) {
      setSkipError(`Could not ${done ? 'skip' : 'restore'}: ${describeError(err)}`);
    }
  };
  // A checked Pending row may have been evaluated in place, so putting it back queues it for a second evaluation.
  const restore = async (url: string, name: string) => {
    if (!(await confirm({ title: `Put ${name} back in the queue?`, body: 'If it was evaluated, not just skipped, Evaluate visible and Batch will see it as new and it will be evaluated again.', confirmLabel: 'Back to queue', danger: true }))) return;
    await skip(url, false);
  };
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
    <>
      {/* Outside the data state: Add URLs is how a first pipeline gets created (appendToPipeline makes the file). */}
      <div className="toolbar" aria-label="Inbox actions">
        <AddUrls onDone={(n) => { setMessage({ tone: 'ok', text: `Added ${n} URL${n === 1 ? '' : 's'} to the pipeline` }); void qc.invalidateQueries({ queryKey: ['pipeline'] }); }} />
        <ActionButton meta={actions.data?.find((a) => a.id === 'pipeline.prioritize')} disabled={busy !== null} onRun={() => void run('pipeline.prioritize', {}, 'Prioritize started')} />
        <ActionButton meta={actions.data?.find((a) => a.id === 'pipeline.shortlist')} disabled={busy !== null} onRun={() => void run('pipeline.shortlist', {}, 'Shortlist rebuild started')} />
        <ActionButton meta={actions.data?.find((a) => a.id === 'pipeline.rank')} disabled={busy !== null} onRun={() => void run('pipeline.rank', { limit: 50 }, 'Rank started')}>
          Rank (50)
        </ActionButton>
      </div>
      <Message message={message} />
      <DataState query={q} missing={<span>No pipeline yet. Add URLs or run a scan from Discover.</span>}>
        <InboxAi urls={visible.filter((r) => !r.done).map((r) => r.url)} />
        {skipError && (
          <p role="alert" className="danger-text">
            {skipError}
          </p>
        )}
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
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show done
          </label>
          <span className="faint">{visible.length} rows</span>
        </div>
        {visible.length === 0 ? (
          <Empty>Nothing matches. Clear a filter or add URLs.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Rank</th>
                  <th scope="col">Company</th>
                  <th scope="col">Role</th>
                  <th scope="col">Location</th>
                  <th scope="col">First seen / posted</th>
                  <th scope="col">
                    <span className="sr-only">Row actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.url} className={r.done ? 'is-done' : ''}>
                    <td title={r.rankReason ?? undefined}>
                      <ScorePill score={r.rank} />
                      {r.rankReason && <span className="sr-only">{r.rankReason}</span>}
                    </td>
                    <td>
                      <div className="clip clip--company" title={r.company}>
                        {r.company || <span className="faint">unknown company</span>}
                      </div>
                      <Pill>{r.source}</Pill>
                    </td>
                    <td>
                      <div className="clamp-2" title={r.role || r.url}>
                        <a href={r.url} target="_blank" rel="noreferrer noopener">
                          {r.role || r.url}
                        </a>
                      </div>
                      <span className="faint small">
                        {/* A checked Pending row was skipped here or evaluated in place by a batch evaluator; a Processed row is finished. */}
                        {r.done && <Pill>{r.section === 'done' ? 'processed' : 'done'}</Pill>}
                        {r.seniority ?? ''}
                      </span>
                    </td>
                    <td className="muted">
                      {r.location && (
                        <div className="clip clip--location" title={r.location}>
                          {r.location}
                        </div>
                      )}
                    </td>
                    <td className="mono muted">
                      <div>{r.firstSeen ?? ''}</div>
                      {r.postedAt && <div className="faint">posted {r.postedAt}</div>}
                    </td>
                    <td>
                      {!r.done ? (
                        <button type="button" aria-label={`Skip ${r.company || r.url}`} onClick={() => void skip(r.url, true)}>
                          Skip
                        </button>
                      ) : r.section !== 'done' ? (
                        <button type="button" aria-label={`Restore ${r.company || r.url}`} onClick={() => void restore(r.url, r.company || r.url)}>
                          Back to queue
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DataState>
    </>
  );
}

function Shortlist() {
  const q = useShortlist();
  return (
    <DataState query={q} missing={<span>No shortlist yet. The daily job or a Rebuild shortlist run creates it.</span>}>
      {q.data?.kind === 'ok' && (
        <div className="stack">
          <p className="muted">{q.data.summary}</p>
          <TableScroll label="Shortlist rows">
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
                      <ShortlistScore score={r.score} />
                    </td>
                    <td className="mono">{r.relevance ?? ''}</td>
                    <td>
                      <SponsorPill tier={r.sponsorTier} />
                      {r.sponsorNote && (
                        <>
                          {' '}
                          <span className="faint small sponsor-note">{r.sponsorNote}</span>
                        </>
                      )}
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
          </TableScroll>
          <div className="card">
            <h2>Excluded by company alerts</h2>
            {q.data.excluded.length === 0 ? (
              <Empty>No companies excluded.</Empty>
            ) : (
              <ul className="bullets">
                {q.data.excluded.map((e) => (
                  <li key={`${e.company} ${e.url ?? e.role}`}>
                    <strong>{e.company}</strong> {e.url ? <a href={e.url} target="_blank" rel="noreferrer noopener">{e.role}</a> : e.role} <Pill tone={alertTone(e.alert)}>{e.alert}</Pill> <span className="muted">{e.headline}</span>
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

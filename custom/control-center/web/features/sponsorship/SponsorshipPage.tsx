import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { SafeMarkdown } from '../../components/Md';
import { useImmigration } from '../../lib/queries';
import { DataState, Empty, Pill, SponsorPill, alertTone, TableScroll } from '../../components/ui';
import { Tabs } from '../../components/ui';
import { useState } from 'react';
import { useActions, useRunAction } from '../../lib/actions';
import { ActionButton, Message } from '../../components/ActionBar';
import { SessionPanel } from '../../components/SessionPanel';
import { summarizeWatcher } from '../../lib/watcherState';
import { LookupTab } from './LookupTab';

const route = getRouteApi('/sponsorship');

function WatcherState({ seen, pendingCount, pendingError }: { seen: unknown; pendingCount: number | null; pendingError: string | null }) {
  const s = summarizeWatcher(seen, pendingCount, pendingError);
  return (
    <div className="card" aria-labelledby="watcher-state">
      <h2 id="watcher-state">Watcher state</h2>
      {s === null ? (
        <Empty>The official-feed watcher has not run yet.</Empty>
      ) : 'error' in s ? (
        <p className="danger-text" role="alert">
          {s.error}
        </p>
      ) : (
        <dl className="kv">
          <div className="kv__pair">
            <dt>Last run</dt>
            <dd className="mono">{s.lastRun ?? 'never'}</dd>
          </div>
          {s.sources.map((src) => (
            <div key={src.name} className="kv__pair">
              <dt>Last success: {src.name}</dt>
              <dd className="mono">{src.lastSuccess}</dd>
            </div>
          ))}
          {s.lastSuccess && (
            <div className="kv__pair">
              <dt>Last success</dt>
              <dd className="mono">{s.lastSuccess}</dd>
            </div>
          )}
          <div className="kv__pair">
            <dt>Items seen</dt>
            <dd className="mono">{s.seenCount}</dd>
          </div>
          <div className="kv__pair">
            <dt>Pending for the AI pass</dt>
            <dd className="mono">{s.pendingError ? <span className="danger-text">{s.pendingError}</span> : (s.pendingCount ?? 'n/a')}</dd>
          </div>
        </dl>
      )}
      {s !== null && (
        <details>
          <summary>Raw seen.json</summary>
          <pre tabIndex={0} className="mono small log">{JSON.stringify(seen, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
export type SponsorshipTab = 'overview' | 'changes' | 'feed' | 'alerts' | 'companies' | 'lookup' | 'tiers';

export function SponsorshipPage() {
  const { tab } = route.useSearch();
  const navigate = useNavigate({ from: '/sponsorship' });
  const q = useImmigration();
  const d = q.data;
  const actions = useActions();
  const { run, message } = useRunAction();
  const [policyPass, setPolicyPass] = useState(false);
  return (
    <section aria-labelledby="page-title">
      <div className="page-header">
        <h1 id="page-title">Sponsorship</h1>
        <div className="row gap">
          <ActionButton meta={actions.data?.find((a) => a.id === 'immigration.watch')} onRun={() => void run('immigration.watch', {}, 'Feed check started; see Runs for its log')}>
            Check official feeds now
          </ActionButton>
          <button type="button" onClick={() => setPolicyPass(true)} disabled={policyPass}>
            Run AI policy pass <Pill tone="warn">Uses tokens</Pill>
          </button>
        </div>
      </div>
      <Message message={message} />
      {policyPass && (
        <SessionPanel
          mode="immigration-policy"
          title="AI policy pass"
          autoStart
          // The server runs the pass on daily-prompt.md filled in with the queued items, and acknowledges them when it is done.
          initialPrompt="Run the daily immigration policy pass."
        />
      )}
      <Tabs
        label="Sponsorship sections"
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'changes', label: 'Policy changes', count: d?.policyChanges.length },
          { id: 'feed', label: 'Official feed', count: d?.officialFeed.length },
          { id: 'alerts', label: 'Company alerts', count: d?.alerts.history.length },
          { id: 'companies', label: 'Company checks', count: d?.companies.length },
          { id: 'lookup', label: 'Lookup' },
          { id: 'tiers', label: 'Tier cache' },
        ]}
        value={tab}
        onChange={(t: SponsorshipTab) => void navigate({ search: { tab: t } })}
      />
      {tab === 'lookup' && <LookupTab />}
      {tab !== 'lookup' && (
        <DataState query={q}>
          {d && (
            <>
              {tab === 'overview' && (
                <div className="stack">
                  {d.digest.kind === 'missing' ? (
                    <div className="card">
                      <strong>No policy digest yet.</strong> <span className="muted">Run the AI policy pass to create data/immigration/policy-digest.md.</span>
                    </div>
                  ) : (
                    d.digest.sections.map((s, i) => (
                      // A manual pass and the daily run can each add a section for the same day.
                      <details key={`${i}-${s.date}`} className="card section" open={s.date === d.digest.kind as string || s === (d.digest.kind === 'ok' ? d.digest.sections[0] : null)}>
                        <summary>
                          <h2 style={{ display: 'inline' }}>{s.date}</h2>
                        </summary>
                        <div className="prose">
                          <SafeMarkdown>
                            {s.body}
                          </SafeMarkdown>
                        </div>
                      </details>
                    ))
                  )}
                  <WatcherState seen={d.seen} pendingCount={d.pendingCount} pendingError={d.pendingError} />
                </div>
              )}
              {tab === 'changes' && d.policyChangesError && (
                <p role="alert" className="danger-text">
                  Policy changes could not be read: {d.policyChangesError}
                </p>
              )}
              {tab === 'changes' && !d.policyChangesError && (
                <TableScroll label="Policy changes">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Detected</th>
                        <th scope="col">Announced</th>
                        <th scope="col">Source</th>
                        <th scope="col">Title</th>
                        <th scope="col">Impact</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.policyChanges.map((c, i) => (
                        <tr key={i}>
                          <td className="mono">{String(c.detected ?? c.detected_date ?? '')}</td>
                          <td className="mono">{String(c.announced ?? c.announced_date ?? '')}</td>
                          <td className="muted">{String(c.source ?? '')}</td>
                          <td>
                            {c.url ? (
                              <a href={String(c.url)} target="_blank" rel="noreferrer noopener">
                                {String(c.title ?? '')}
                              </a>
                            ) : (
                              String(c.title ?? '')
                            )}
                          </td>
                          <td className="muted">{String(c.impact ?? '')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              )}
              {tab === 'feed' &&
                (d.officialFeed.length === 0 ? (
                  <Empty>No official feed rows yet.</Empty>
                ) : (
                  <TableScroll label="Official feed">
                    <table className="table">
                      <thead>
                        <tr>
                          {Object.keys(d.officialFeed[0]!).map((k) => (
                            <th key={k} scope="col">
                              {k}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {d.officialFeed.map((row, i) => (
                          <tr key={i}>
                            {Object.entries(row).map(([k, v]) => (
                              <td key={k} className={k === 'first_seen' || k === 'published' ? 'mono' : ''}>
                                {k === 'url' ? (
                                  <a href={v} target="_blank" rel="noreferrer noopener">
                                    link
                                  </a>
                                ) : (
                                  v
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableScroll>
                ))}
              {tab === 'alerts' && d.alertsError && (
                <p role="alert" className="danger-text">
                  The latest alert per company could not be read: {d.alertsError}
                </p>
              )}
              {tab === 'alerts' && (
                <TableScroll label="Company alerts">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Date</th>
                        <th scope="col">Company</th>
                        <th scope="col">Status</th>
                        <th scope="col">Headline</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.alerts.history.map((a, i) => (
                        <tr key={i}>
                          <td className="mono">{String(a.date ?? '')}</td>
                          <td>{String(a.company ?? '')}</td>
                          <td>
                            <Pill tone={alertTone(String(a.status))}>{String(a.status)}</Pill>
                          </td>
                          <td>
                            {a.url ? (
                              <a href={String(a.url)} target="_blank" rel="noreferrer noopener">
                                {String(a.headline ?? '')}
                              </a>
                            ) : (
                              String(a.headline ?? '')
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              )}
              {tab === 'companies' &&
                (d.companies.length === 0 ? (
                  <Empty>No company checks yet.</Empty>
                ) : (
                  <TableScroll label="Company checks">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Company</th>
                          <th scope="col">Verdict</th>
                          <th scope="col">DOL tier</th>
                          <th scope="col">Checked</th>
                          <th scope="col">Policy changes seen</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.companies.map((c) => (
                          <tr key={c.slug}>
                            <td>{c.name}</td>
                            <td>
                              <SponsorPill tier={c.verdict} />
                            </td>
                            <td>{c.dolTier ?? 'unknown'}</td>
                            <td className="mono">{c.checkedAt ?? 'never'}</td>
                            <td className="mono">{c.policyChangesSeen ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableScroll>
                ))}
              {tab === 'tiers' && (
                <div className="card">
                  <h2>sponsor-tiers.json</h2>
                  {d.tiers ? <pre className="mono small">{JSON.stringify(d.tiers, null, 2)}</pre> : <Empty>No tier cache yet.</Empty>}
                </div>
              )}
            </>
          )}
        </DataState>
      )}
    </section>
  );
}

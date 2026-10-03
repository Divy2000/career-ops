import { getRouteApi, useNavigate } from '@tanstack/react-router';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { useImmigration } from '../../lib/queries';
import { DataState, Empty, Pill, SponsorPill, alertTone } from '../../components/ui';
import { Tabs } from '../../components/ui';

const route = getRouteApi('/sponsorship');
export type SponsorshipTab = 'overview' | 'changes' | 'feed' | 'alerts' | 'companies' | 'lookup' | 'tiers';

export function SponsorshipPage() {
  const { tab } = route.useSearch();
  const navigate = useNavigate({ from: '/sponsorship' });
  const q = useImmigration();
  const d = q.data;
  return (
    <section aria-labelledby="page-title">
      <div className="page-header">
        <h1 id="page-title">Sponsorship</h1>
        <div className="row gap">
          <button type="button" disabled title="Script runs arrive with the runner phase">
            Check official feeds now
          </button>
          <button type="button" disabled title="Sessions arrive with the Claude engine phase">
            Run AI policy pass
          </button>
        </div>
      </div>
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
                  d.digest.sections.map((s) => (
                    <details key={s.date} className="card section" open={s.date === d.digest.kind as string || s === (d.digest.kind === 'ok' ? d.digest.sections[0] : null)}>
                      <summary>
                        <h2 style={{ display: 'inline' }}>{s.date}</h2>
                      </summary>
                      <div className="prose">
                        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                          {s.body}
                        </Markdown>
                      </div>
                    </details>
                  ))
                )}
                <div className="card">
                  <h2>Watcher state</h2>
                  <pre className="mono small">{JSON.stringify(d.seen, null, 2)}</pre>
                </div>
              </div>
            )}
            {tab === 'changes' && (
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
            )}
            {tab === 'feed' &&
              (d.officialFeed.length === 0 ? (
                <Empty>No official feed rows yet.</Empty>
              ) : (
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
                          <td key={k} className={k === 'date' ? 'mono' : ''}>
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
              ))}
            {tab === 'alerts' && (
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
            )}
            {tab === 'companies' &&
              (d.companies.length === 0 ? (
                <Empty>No company checks yet.</Empty>
              ) : (
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
              ))}
            {tab === 'lookup' && (
              <div className="card">
                <Empty>The H-1B sponsor lookup runs plugins/h1b-sponsor/check.mjs and lands with the runner phase.</Empty>
              </div>
            )}
            {tab === 'tiers' && (
              <div className="card">
                <h2>sponsor-tiers.json</h2>
                {d.tiers ? <pre className="mono small">{JSON.stringify(d.tiers, null, 2)}</pre> : <Empty>No tier cache yet.</Empty>}
              </div>
            )}
          </>
        )}
      </DataState>
    </section>
  );
}

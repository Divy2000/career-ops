import { useState } from 'react';
import { Link, getRouteApi } from '@tanstack/react-router';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { useApplication } from '../../lib/queries';
import { DataState, Empty, Pill, ScorePill, SponsorPill, StatusPill, Tabs, alertTone } from '../../components/ui';
import { DocumentsTab } from './DocumentsTab';
import { DangerZone } from './DangerZone';
import type { ReportFull } from '@shared/api';

const route = getRouteApi('/tracker/$n');
type Tab = 'report' | 'documents' | 'sponsorship' | 'outreach' | 'interview' | 'offer' | 'timeline' | 'sessions';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'report', label: 'Report' },
  { id: 'documents', label: 'Documents' },
  { id: 'sponsorship', label: 'Sponsorship' },
  { id: 'outreach', label: 'Outreach' },
  { id: 'interview', label: 'Interview' },
  { id: 'offer', label: 'Offer & Outcome' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'sessions', label: 'Sessions' },
];

export const APPLY_LINE = 4.0;

export function applyLineLabel(score: number | null): string {
  if (score === null) return 'No score recorded';
  if (score >= APPLY_LINE) return `At or above the ${APPLY_LINE.toFixed(1)} apply line`;
  return `Below the ${APPLY_LINE.toFixed(1)} apply line`;
}

function Verdict({ report }: { report: ReportFull }) {
  return (
    <div className={`card verdict verdict--${report.score !== null && report.score >= APPLY_LINE ? 'go' : 'hold'}`}>
      <div className="row gap">
        <ScorePill score={report.score} />
        <span>{applyLineLabel(report.score)}</span>
        {report.finalDecision && <Pill tone="accent">Recommendation: {report.finalDecision}</Pill>}
        {report.legitimacy && <Pill tone={/suspicious/i.test(report.legitimacy) ? 'danger' : /caution/i.test(report.legitimacy) ? 'warn' : 'ok'}>{report.legitimacy}</Pill>}
      </div>
      {report.tldr && <p style={{ marginBottom: 0 }}>{report.tldr}</p>}
      {report.discardReasons.length > 0 && (
        <p className="muted" style={{ marginBottom: 0 }}>
          Discard reasons: {report.discardReasons.join(', ')}
        </p>
      )}
    </div>
  );
}

export function ApplicationPage() {
  const { n } = route.useParams();
  const q = useApplication(n);
  const [tab, setTab] = useState<Tab>('report');

  return (
    <section aria-labelledby="page-title">
      <p>
        <Link to="/tracker">Back to tracker</Link>
      </p>
      <DataState query={q}>
        {q.data && (
          <>
            <div className="page-header">
              <div>
                <h1 id="page-title">{q.data.row.company}</h1>
                <p className="muted" style={{ margin: 0 }}>
                  {q.data.row.role}
                </p>
              </div>
              <div className="row gap">
                <ScorePill score={q.data.row.score} />
                <StatusPill status={q.data.row.status} />
                {q.data.row.summary?.legitimacy && <Pill>{q.data.row.summary.legitimacy}</Pill>}
                <SponsorPill tier={q.data.sponsorship.companyFile?.verdict ?? q.data.sponsorship.companyFile?.dolTier} />
                {q.data.row.url && (
                  <a className="button-link" href={q.data.row.url} target="_blank" rel="noreferrer noopener">
                    Open posting
                  </a>
                )}
              </div>
            </div>
            <Tabs label="Application sections" tabs={TABS} value={tab} onChange={setTab} />

            {tab === 'report' && <ReportTab report={q.data.report} />}

            {tab === 'timeline' && (
              <div className="stack">
                <div className="card">
                  <h2>Status log</h2>
                  {q.data.timeline.statusLog.length === 0 ? (
                    <Empty>No transitions recorded in status-log.tsv for this row.</Empty>
                  ) : (
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Date</th>
                          <th scope="col">From</th>
                          <th scope="col">To</th>
                          <th scope="col">Source</th>
                          <th scope="col">Note</th>
                        </tr>
                      </thead>
                      <tbody>
                        {q.data.timeline.statusLog.map((s, i) => (
                          <tr key={i}>
                            <td className="mono">{s.date}</td>
                            <td>{s.from}</td>
                            <td>
                              <StatusPill status={s.to} />
                            </td>
                            <td className="muted">{s.source}</td>
                            <td className="muted">{s.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                <div className="card">
                  <h2>Follow-ups</h2>
                  {q.data.timeline.pin && (
                    <p className="muted">
                      Next pinned to <span className="mono">{q.data.timeline.pin.date}</span> (set {q.data.timeline.pin.setOn})
                    </p>
                  )}
                  {q.data.timeline.followups.length === 0 ? (
                    <Empty>No follow-ups logged.</Empty>
                  ) : (
                    <ul className="bullets">
                      {q.data.timeline.followups.map((f) => (
                        <li key={f.num}>
                          <span className="mono">{f.date}</span> <Pill>{f.channel}</Pill> {f.contact} <span className="muted">{f.notes}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="card">
                  <h2>Company history</h2>
                  {q.data.companyHistory.length === 0 ? (
                    <Empty>No other applications at this company.</Empty>
                  ) : (
                    <ul className="bullets">
                      {q.data.companyHistory.map((r) => (
                        <li key={r.num}>
                          <Link to="/tracker/$n" params={{ n: String(r.num) }}>
                            #{r.num} {r.role}
                          </Link>{' '}
                          <StatusPill status={r.status} /> <span className="mono faint">{r.date}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}

            {tab === 'sponsorship' && (
              <div className="card">
                <h2>Sponsorship</h2>
                {q.data.sponsorship.companyFile ? (
                  <dl className="kv">
                    <dt>Verdict</dt>
                    <dd>
                      <SponsorPill tier={q.data.sponsorship.companyFile.verdict} />
                    </dd>
                    <dt>DOL tier</dt>
                    <dd>{q.data.sponsorship.companyFile.dolTier ?? 'unknown'}</dd>
                    <dt>Checked</dt>
                    <dd className="mono">{q.data.sponsorship.companyFile.checkedAt ?? 'never'}</dd>
                  </dl>
                ) : (
                  <Empty>No company sponsorship file yet. The check session arrives with the Claude engine phase.</Empty>
                )}
                {q.data.sponsorship.alert && (
                  <p>
                    <Pill tone={alertTone(String(q.data.sponsorship.alert.status))}>{String(q.data.sponsorship.alert.status)}</Pill> {String(q.data.sponsorship.alert.headline)}
                  </p>
                )}
              </div>
            )}

            {tab === 'documents' && (
              <div className="stack">
                <DocumentsTab n={q.data.row.num} />
                <DangerZone n={q.data.row.num} />
              </div>
            )}

            {tab !== 'report' && tab !== 'timeline' && tab !== 'sponsorship' && tab !== 'documents' && (
              <div className="card">
                <Empty>This tab lands in a later build phase.</Empty>
              </div>
            )}
          </>
        )}
      </DataState>
    </section>
  );
}

function ReportTab({ report }: { report: NonNullable<ReturnType<typeof useApplication>['data']>['report'] }) {
  if (report.kind === 'none') return <div className="card"><Empty>This row has no report linked.</Empty></div>;
  if (report.kind === 'missing') return <div className="card"><strong>Report file missing</strong> <span className="muted">(#{report.num}).</span></div>;
  if (report.kind === 'reserved') return <div className="card"><strong>Report number reserved</strong> <span className="muted mono">{report.file}</span> <span className="muted">An evaluation is in progress or was abandoned.</span></div>;
  if (report.kind === 'malformed')
    return (
      <div className="card card--warn" role="alert">
        <strong>Report malformed:</strong> {report.error} <span className="mono faint">{report.file}{report.line ? `:${report.line}` : ''}</span>
      </div>
    );
  const r = report.report;
  return (
    <div className="stack">
      <Verdict report={r} />
      {r.sections
        .filter((s) => !/^Machine Summary$/i.test(s.heading))
        .map((s, i) => (
          <details key={i} className="card section" open={i < 2 || s.letter === 'A' || s.letter === 'B'}>
            <summary>
              <h2 style={{ display: 'inline' }}>{s.heading}</h2>
            </summary>
            <div className="prose">
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                {s.content}
              </Markdown>
            </div>
          </details>
        ))}
      {r.machine && (
        <details className="card section">
          <summary>
            <h2 style={{ display: 'inline' }}>Machine summary</h2>
          </summary>
          <pre className="mono">{JSON.stringify(r.machine, null, 2)}</pre>
        </details>
      )}
      <details className="card section">
        <summary>
          <h2 style={{ display: 'inline' }}>Score methodology</h2>
        </summary>
        <p className="muted">
          One global 1 to 5 score decided from CV match, North Star alignment, compensation, cultural signals and red flags. Blocks A to H are sections, not inputs to average. The apply line is {APPLY_LINE.toFixed(1)}; posting legitimacy is a separate judgment.
        </p>
      </details>
    </div>
  );
}

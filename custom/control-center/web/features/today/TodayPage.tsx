import { Link } from '@tanstack/react-router';
import { useFollowups, useImmigration, useShortlist, useTracker, useWhatsNew } from '../../lib/queries';
import { DataState, Empty, Pill, ScorePill, SponsorPill, alertTone, TableScroll } from '../../components/ui';
import { summarizeDigest, type DigestSpan } from '../../lib/digestSummary';
import { QuickEvaluate } from './QuickEvaluate';
import { localDate } from '@shared/local-date';

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

function DigestLine({ spans }: { spans: DigestSpan[] }) {
  return (
    <span className="md-inline">
      {spans.map((s, i) => {
        const text = s.bold ? <strong>{s.text}</strong> : s.text;
        return s.href && SAFE_HREF.test(s.href) ? (
          <a key={i} href={s.href} target="_blank" rel="noreferrer noopener">
            {text}
          </a>
        ) : (
          <span key={i}>{text}</span>
        );
      })}
    </span>
  );
}

function DailyJobChip() {
  const q = useImmigration();
  if (q.isPending) return <Pill>Daily job: checking</Pill>;
  if (q.isError || !q.data) return <Pill tone="danger">Daily job: unknown</Pill>;
  const log = q.data.dailyLog;
  if (!log) return <Pill tone="warn">Daily job: no log yet</Pill>;
  if (log.status === 'failed') {
    // A failure line can run long (it says how to fix it); the chip keeps its first sentence and the title has it all.
    const reason = log.failedSteps.join(', ') || log.problems[0]?.split(/\.\s/)[0] || 'see log';
    return (
      <Pill tone="danger" title={[...log.failedSteps.map((s) => `Failed step: ${s}`), ...log.problems].join('\n')}>
        Daily job {log.date}: failed ({reason})
      </Pill>
    );
  }
  if (log.status === 'running') return <Pill tone="info">Daily job {log.date}: running</Pill>;
  if (log.status === 'interrupted') return <Pill tone="warn" title="The last run has no done line and run-daily.sh is not running: it was cancelled, killed or stopped early. See Runs & Schedule > Job logs.">Daily job {log.date}: interrupted</Pill>;
  return <Pill tone="ok">Daily job {log.date}: ok</Pill>;
}

function DigestChip() {
  const q = useImmigration();
  if (!q.data || q.data.digest.kind !== 'ok') return null;
  const stale = q.data.digest.staleDays;
  if (stale === null) return null;
  return <Pill tone={stale > 2 ? 'warn' : 'neutral'}>Digest {stale > 2 ? `${stale} days old` : 'fresh'}</Pill>;
}

export function TodayPage() {
  const shortlist = useShortlist();
  const immigration = useImmigration();
  const tracker = useTracker();
  const followups = useFollowups();
  const fresh = useWhatsNew(7, 6);
  const today = localDate();
  const trackerEmpty = tracker.data?.kind === 'missing' || (tracker.data?.kind === 'ok' && tracker.data.rows.length === 0);

  return (
    <section aria-labelledby="page-title">
      <div className="page-header">
        <h1 id="page-title">Today</h1>
        <div className="row gap">
          <span className="muted mono">{today}</span>
          <DailyJobChip />
          <DigestChip />
        </div>
      </div>

      <QuickEvaluate />

      {trackerEmpty && (
        <div className="card hero">
          <h2>Start with your CV</h2>
          <p className="muted">No applications yet. Import your CV on the Profile & CV page, then run a free scan to seed matches.</p>
          <Link to="/profile" className="button-link">
            Go to Profile & CV
          </Link>
        </div>
      )}

      <div className="grid-2 grid-2--today">
        <div className="stack">
          <div className="card">
            <h2>Shortlist top 15</h2>
            <DataState query={shortlist} missing={<span>Run the daily job or Pipeline &gt; Rebuild shortlist.</span>}>
              {shortlist.data?.kind === 'ok' && (
                <>
                  <p className="faint" style={{ marginTop: 4 }}>
                    {shortlist.data.date ? `Built ${shortlist.data.date}. ` : ''}
                    {shortlist.data.summary}
                  </p>
                  {shortlist.data.rows.length === 0 ? (
                    <Empty>No ranked rows yet. Rank the pipeline to fill this list.</Empty>
                  ) : (
                    <TableScroll label="Shortlist top 15">
  <table className="table table--compact-cells">
                        <thead>
                          <tr>
                            <th scope="col">Score</th>
                            <th scope="col">Company</th>
                            <th scope="col">Role</th>
                            <th scope="col">Posted</th>
                            <th scope="col">
                              <span className="sr-only">Actions</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {shortlist.data.rows.slice(0, 15).map((r) => (
                            <tr key={r.rank}>
                              <td>
                                <div className="stack-tight">
                                  <ScorePill score={r.score} />
                                  <SponsorPill tier={r.sponsor} />
                                </div>
                              </td>
                              <td>
                                <div className="clip clip--company" title={r.company}>
                                  {r.company}
                                </div>
                                {r.location && (
                                  <div className="clip clip--company muted small" title={r.location}>
                                    {r.location}
                                  </div>
                                )}
                              </td>
                              <td>
                                <div className="clamp-2" title={r.role}>
                                  {r.url ? <a href={r.url} target="_blank" rel="noreferrer noopener">{r.role}</a> : r.role}
                                </div>
                              </td>
                              <td className="mono muted">{r.posted ?? ''}</td>
                              <td>
                                <button type="button" disabled title="Evaluate sessions arrive with the Claude engine phase">
                                  Evaluate
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableScroll>
                  )}
                  {shortlist.data.excluded.length > 0 && (
                    <details style={{ marginTop: 12 }}>
                      <summary>Excluded by company alerts ({shortlist.data.excluded.length})</summary>
                      <ul>
                        {shortlist.data.excluded.map((e) => (
                          <li key={e.company}>
                            <strong>{e.company}</strong> <Pill tone={alertTone(e.alert)}>{e.alert}</Pill> <span className="muted">{e.headline}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              )}
            </DataState>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <h2>Policy today</h2>
            <DataState query={immigration}>
              {immigration.data && immigration.data.digest.kind === 'ok' && immigration.data.digest.sections[0] ? (
                <>
                  <p className="faint">{immigration.data.digest.sections[0].date}</p>
                  <ul className="bullets" aria-label="Policy highlights">
                    {summarizeDigest(immigration.data.digest.sections[0].body).map((line, i) => (
                      <li key={i}>
                        <DigestLine spans={line} />
                      </li>
                    ))}
                  </ul>
                  <Link to="/sponsorship" search={{ tab: 'overview' }}>
                    Read full digest
                  </Link>
                </>
              ) : (
                <Empty>No digest yet. Run the AI policy pass from Sponsorship.</Empty>
              )}
              {immigration.data && immigration.data.alerts.latest.length > 0 && (
                <ul className="bullets">
                  {immigration.data.alerts.latest.slice(0, 3).map((a, i) => (
                    <li key={i}>
                      <Pill tone={alertTone(String(a.status))}>{String(a.status)}</Pill> <strong>{String(a.company)}</strong> <span className="muted">{String(a.headline)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </DataState>
          </div>

          <div className="card">
            <h2>Follow-ups due</h2>
            <DataState query={followups}>
              {followups.data && (
                <>
                  {followups.data.entries.filter((e) => e.urgency === 'overdue' || e.urgency === 'urgent').length === 0 ? (
                    <Empty>Nothing due. Check the Follow-ups page for the full cadence.</Empty>
                  ) : (
                    <ul className="bullets">
                      {followups.data.entries
                        .filter((e) => e.urgency === 'overdue' || e.urgency === 'urgent')
                        .map((e) => (
                          <li key={e.num}>
                            <Pill tone={e.urgency === 'overdue' ? 'danger' : 'warn'}>{e.urgency}</Pill>{' '}
                            <Link to="/tracker/$n" params={{ n: String(e.num) }}>
                              {e.company}
                            </Link>{' '}
                            <span className="muted">{e.role}</span> <span className="faint mono">next {e.nextFollowupDate ?? 'n/a'}</span>
                          </li>
                        ))}
                    </ul>
                  )}
                </>
              )}
            </DataState>
          </div>

          <div className="card">
            <h2>Decisions</h2>
            <DataState query={tracker}>
              {tracker.data?.kind === 'ok' && (
                <>
                  {tracker.data.rows.filter((r) => r.status === 'Evaluated').length === 0 ? (
                    <Empty>No evaluated offers waiting for a decision.</Empty>
                  ) : (
                    <ul className="bullets">
                      {tracker.data.rows
                        .filter((r) => r.status === 'Evaluated')
                        .map((r) => (
                          <li key={r.num} className="row gap">
                            <ScorePill score={r.score} />
                            <Link to="/tracker/$n" params={{ n: String(r.num) }}>
                              {r.company}
                            </Link>
                            <span className="muted">{r.role}</span>
                            <button type="button" disabled title="Status changes arrive with the runner phase">
                              Applied
                            </button>
                            <button type="button" disabled title="Status changes arrive with the runner phase">
                              Skip
                            </button>
                          </li>
                        ))}
                    </ul>
                  )}
                </>
              )}
            </DataState>
          </div>

          <div className="card">
            <h2>Fresh matches this week</h2>
            <DataState query={fresh}>
              {fresh.data && (
                <>
                  {fresh.data.offers.length === 0 ? (
                    <Empty>No new unevaluated postings in the last 7 days. Run a scan from Discover.</Empty>
                  ) : (
                    <ul className="bullets">
                      {fresh.data.offers.map((o) => (
                        <li key={o.url}>
                          <a href={o.url} target="_blank" rel="noreferrer noopener">
                            {o.title}
                          </a>{' '}
                          <span className="muted">{o.company}</span> <span className="faint mono">{o.firstSeen}</span> <Pill>{o.ats}</Pill>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="faint">{fresh.data.count} total</p>
                </>
              )}
            </DataState>
          </div>
        </div>
      </div>
    </section>
  );
}

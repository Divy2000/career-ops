import { Link } from '@tanstack/react-router';
import { useFollowups } from '../../lib/queries';
import { DataState, Empty, Pill, StatusPill } from '../../components/ui';

function urgencyTone(u: string): 'danger' | 'warn' | 'neutral' | 'info' {
  if (u === 'overdue') return 'danger';
  if (u === 'urgent') return 'warn';
  if (u === 'waiting') return 'info';
  return 'neutral';
}

export function FollowupsPage() {
  const q = useFollowups();
  return (
    <section aria-labelledby="page-title">
      <div className="page-header">
        <h1 id="page-title">Follow-ups</h1>
        {q.data && (
          <span className="faint">
            {q.data.metadata.actionable} actionable of {q.data.metadata.totalTracked} tracked
          </span>
        )}
      </div>
      <DataState query={q}>
        {q.data &&
          (q.data.entries.length === 0 ? (
            <Empty>No applications in follow-up cadence yet.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Urgency</th>
                  <th scope="col">Company</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Applied</th>
                  <th scope="col">Next</th>
                  <th scope="col">Follow-ups</th>
                </tr>
              </thead>
              <tbody>
                {q.data.entries.map((e) => (
                  <tr key={e.num}>
                    <td>
                      <Pill tone={urgencyTone(e.urgency)}>{e.urgency}</Pill>
                    </td>
                    <td>
                      <Link to="/tracker/$n" params={{ n: String(e.num) }}>
                        {e.company}
                      </Link>
                    </td>
                    <td className="muted">{e.role}</td>
                    <td>
                      <StatusPill status={e.status.charAt(0).toUpperCase() + e.status.slice(1)} />
                    </td>
                    <td className="mono">{e.appliedDate}</td>
                    <td className="mono">
                      {e.nextFollowupDate ?? 'n/a'} {e.daysUntilNext !== null && <span className="faint">({e.daysUntilNext}d)</span>}
                    </td>
                    <td className="mono">{e.followupCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      </DataState>
    </section>
  );
}

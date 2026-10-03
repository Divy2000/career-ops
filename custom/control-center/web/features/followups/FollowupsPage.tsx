import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useFollowups } from '../../lib/queries';
import { apiSend } from '../../lib/api';
import { describeError } from '../../lib/actions';
import { DataState, Empty, Pill, StatusPill } from '../../components/ui';
import type { FollowupCadenceEntry } from '@shared/api';

function urgencyTone(u: string): 'danger' | 'warn' | 'neutral' | 'info' {
  if (u === 'overdue') return 'danger';
  if (u === 'urgent') return 'warn';
  if (u === 'waiting') return 'info';
  return 'neutral';
}

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

function LogForm({ entry, onDone }: { entry: FollowupCadenceEntry; onDone: (msg: string) => void }) {
  const [date, setDate] = useState(today());
  const [channel, setChannel] = useState('Email');
  const [contact, setContact] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    try {
      const r = await apiSend<{ num: number }>('POST', '/api/followups/log', { appNum: entry.num, date, channel, contact, notes });
      onDone(`Logged follow-up #${r.num} for ${entry.company}`);
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <div className="card stack" role="dialog" aria-label={`Log follow-up for ${entry.company}`}>
      <div className="row gap">
        <label>
          <span className="muted">Date</span> <input type="date" aria-label="Follow-up date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          <span className="muted">Channel</span>{' '}
          <select aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value)}>
            {['Email', 'LinkedIn', 'Phone', 'Portal', 'Other'].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="muted">Contact</span> <input aria-label="Contact" value={contact} onChange={(e) => setContact(e.target.value)} />
        </label>
      </div>
      <input aria-label="Notes" placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      {error && (
        <p role="alert" className="danger-text">
          {error}
        </p>
      )}
      <div className="row gap">
        <button type="button" onClick={() => void submit()}>
          Save follow-up
        </button>
        <button type="button" onClick={() => onDone('')}>
          Cancel
        </button>
      </div>
    </div>
  );
}

import { ModeLauncher } from '../../components/ModeLauncher';

export function FollowupsPage() {
  const q = useFollowups();
  const qc = useQueryClient();
  const [logging, setLogging] = useState<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['followups'] }), qc.invalidateQueries({ queryKey: ['tracker'] })]);
  const pin = async (appNum: number, date: string | null) => {
    try {
      if (date) await apiSend('POST', '/api/followups/override', { appNum, date });
      else await apiSend('DELETE', '/api/followups/override', { appNum });
      setMessage(date ? `Next follow-up pinned to ${date}` : 'Pin cleared');
      await refresh();
    } catch (err) {
      setMessage(`Could not update pin: ${describeError(err)}`);
    }
  };
  const remove = async (num: number) => {
    try {
      await apiSend('DELETE', '/api/followups/log', { num });
      setMessage(`Deleted follow-up #${num}`);
      await refresh();
    } catch (err) {
      setMessage(`Could not delete: ${describeError(err)}`);
    }
  };
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
      <ModeLauncher
        heading="AI drafts"
        modes={[
          { id: 'followup', label: 'Draft follow-ups', prompt: 'Draft follow-up messages for every overdue and urgent application.' },
          { id: 'reply-watch', label: 'Reply watch', prompt: 'Review the reply candidates and suggest status changes (ask before any change).' },
        ]}
      />
      {message && (
        <p role="status" className={message.startsWith('Could not') ? 'danger-text' : 'muted'}>
          {message}
        </p>
      )}
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
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {q.data.entries.map((e) => (
                  <RowGroup key={e.num} e={e} open={open === e.num} onToggle={() => setOpen(open === e.num ? null : e.num)} logging={logging === e.num} onLog={() => setLogging(e.num)} onLogged={(m) => { setLogging(null); if (m) { setMessage(m); void refresh(); } }} onPin={pin} onDelete={remove} />
                ))}
              </tbody>
            </table>
          ))}
      </DataState>
    </section>
  );
}

function RowGroup({ e, open, onToggle, logging, onLog, onLogged, onPin, onDelete }: { e: FollowupCadenceEntry; open: boolean; onToggle: () => void; logging: boolean; onLog: () => void; onLogged: (m: string) => void; onPin: (appNum: number, date: string | null) => void; onDelete: (num: number) => void }) {
  return (
    <>
      <tr>
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
          {e.nextOverride ? <Pill tone="accent">pinned</Pill> : null}
        </td>
        <td className="mono">
          <button type="button" className="th-button" aria-expanded={open} onClick={onToggle} aria-label={`Show history for ${e.company}`}>
            {e.followupCount}
          </button>
        </td>
        <td>
          <div className="row gap">
            <button type="button" aria-label={`Log follow-up for ${e.company}`} onClick={onLog}>
              Log
            </button>
            <button type="button" aria-label={`Pin next follow-up for ${e.company} in 7 days`} onClick={() => onPin(e.num, plusDays(7))}>
              +7d
            </button>
            <button type="button" aria-label={`Clear pinned date for ${e.company}`} onClick={() => onPin(e.num, null)} disabled={!e.nextOverride}>
              Clear pin
            </button>
          </div>
        </td>
      </tr>
      {logging && (
        <tr>
          <td colSpan={8}>
            <LogForm entry={e} onDone={onLogged} />
          </td>
        </tr>
      )}
      {open && (
        <tr>
          <td colSpan={8}>
            {e.followups.length === 0 ? (
              <Empty>No follow-ups logged yet.</Empty>
            ) : (
              <ul className="bullets" aria-label={`Follow-up history for ${e.company}`}>
                {e.followups.map((f) => (
                  <li key={f.num}>
                    <span className="mono">{f.date}</span> {f.channel} {f.contact && <span className="muted">to {f.contact}</span>} <span className="faint">{f.notes}</span>{' '}
                    <button type="button" aria-label={`Delete follow-up ${f.num}`} onClick={() => onDelete(f.num)}>
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

import { useState } from 'react';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFollowups } from '../../lib/queries';
import { apiGet, apiSend } from '../../lib/api';
import { describeError, useActions, useRunAction } from '../../lib/actions';
import { ActionButton, Message } from '../../components/ActionBar';
import { DataState, Empty, Pill, StatusPill, Tabs } from '../../components/ui';
import { ModeLauncher } from '../../components/ModeLauncher';
import type { ContactsRead, FollowupCadenceEntry } from '@shared/api';

const route = getRouteApi('/followups');
export type FollowupsTab = 'cadence' | 'replies' | 'contacts';

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

function CadenceTab() {
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
    <>
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
            <Empty>No applications in follow-up cadence yet. Once you apply to a job, its follow-ups are scheduled here.</Empty>
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
                  <RowGroup
                    key={e.num}
                    e={e}
                    open={open === e.num}
                    onToggle={() => setOpen(open === e.num ? null : e.num)}
                    logging={logging === e.num}
                    onLog={() => setLogging(e.num)}
                    onLogged={(m) => {
                      setLogging(null);
                      if (m) {
                        setMessage(m);
                        void refresh();
                      }
                    }}
                    onPin={pin}
                    onDelete={remove}
                  />
                ))}
              </tbody>
            </table>
          ))}
      </DataState>
    </>
  );
}

function RepliesTab() {
  const actions = useActions();
  const { run, message, busy } = useRunAction();
  const [subject, setSubject] = useState('');
  const [from, setFrom] = useState('');
  const [body, setBody] = useState('');
  const [invite, setInvite] = useState('');
  const [result, setResult] = useState<unknown>(null);
  return (
    <div className="stack">
      <div className="card" aria-labelledby="paste-heading">
        <h2 id="paste-heading">Paste a reply</h2>
        <p className="muted small">Feeds paste-reply.mjs through a temp file (no Gmail needed); reply-watch then classifies it.</p>
        <div className="row gap">
          <input aria-label="Reply subject" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          <input aria-label="Reply sender" placeholder="From (optional)" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <textarea aria-label="Reply body" rows={6} placeholder="Paste the email body" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="row gap">
          <ActionButton meta={actions.data?.find((a) => a.id === 'followups.replyPaste')} disabled={busy !== null || !subject.trim() || !body.trim()} params={{ subject, from, body }} onRun={(p) => void run('followups.replyPaste', p)} />
          <ActionButton meta={actions.data?.find((a) => a.id === 'followups.replyWatch')} disabled={busy !== null} onRun={() => void run('followups.replyWatch', {})} />
        </div>
      </div>
      <div className="card" aria-labelledby="invite-heading">
        <h2 id="invite-heading">Match an interview invite</h2>
        <textarea aria-label="Invite text" rows={4} placeholder="Paste the invite text to match it to a tracker row" value={invite} onChange={(e) => setInvite(e.target.value)} />
        <ActionButton meta={actions.data?.find((a) => a.id === 'followups.inviteMatch')} disabled={busy !== null || !invite.trim()} params={{ text: invite }} onRun={(p) => void run('followups.inviteMatch', p).then((out) => out && 'result' in out && setResult(out.result))} />
        {result !== null && <pre tabIndex={0} className="log mono small">{typeof result === 'string' ? result : JSON.stringify(result, null, 2)}</pre>}
      </div>
      <Message message={message} />
      <ModeLauncher heading="Reply watch session" modes={[{ id: 'reply-watch', label: 'Reply watch', prompt: 'Review the reply candidates and suggest status changes (ask before any change).' }]} />
    </div>
  );
}

function ContactsTab() {
  const q = useQuery({ queryKey: ['followups', 'contacts'], queryFn: () => apiGet<ContactsRead>('/api/contacts') });
  const actions = useActions();
  const { run, message, busy } = useRunAction();
  const [callerId, setCallerId] = useState('career-ops');
  const exportVcf = async () => {
    const out = await run('followups.contactsVcf', { callerId }, 'vCard export ready');
    if (out && 'result' in out) {
      const text = typeof out.result === 'string' ? out.result : JSON.stringify(out.result);
      const url = URL.createObjectURL(new Blob([text], { type: 'text/vcard' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'career-ops-contacts.vcf';
      a.click();
      URL.revokeObjectURL(url);
    }
  };
  return (
    <div className="card" aria-labelledby="contacts-heading">
      <div className="row gap" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <h2 id="contacts-heading" style={{ margin: 0 }}>
          Contacts (data/contacts.tsv)
        </h2>
        <div className="row gap">
          <input aria-label="vCard caller id" value={callerId} onChange={(e) => setCallerId(e.target.value)} style={{ width: 140 }} />
          <ActionButton meta={actions.data?.find((a) => a.id === 'followups.contactsVcf')} disabled={busy !== null} onRun={() => void exportVcf()}>
            Export vCard
          </ActionButton>
          <ActionButton meta={actions.data?.find((a) => a.id === 'followups.linkedinJoin')} disabled={busy !== null} onRun={() => void run('followups.linkedinJoin', {})} />
        </div>
      </div>
      <Message message={message} />
      <DataState query={q}>
        {q.data?.kind === 'ok' &&
          (q.data.rows.length === 0 ? (
            <Empty>No contacts yet. The contacto and email modes add them as you reach out.</Empty>
          ) : (
            <table className="table" aria-label="Contacts">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Company</th>
                  <th scope="col">Type</th>
                  <th scope="col">Title</th>
                  <th scope="col">Channels</th>
                  <th scope="col">App</th>
                  <th scope="col">Notes</th>
                </tr>
              </thead>
              <tbody>
                {q.data.rows.map((c) => (
                  <tr key={c.line}>
                    <td>{c.name}</td>
                    <td>{c.company}</td>
                    <td>
                      <Pill>{c.type || 'contact'}</Pill>
                    </td>
                    <td className="muted">{c.title}</td>
                    <td className="small">{[c.email, c.phone, c.linkedin].filter(Boolean).join(' / ') || <span className="faint">none</span>}</td>
                    <td>
                      {c.tracker !== null ? (
                        <Link to="/tracker/$n" params={{ n: String(c.tracker) }}>
                          #{c.tracker}
                        </Link>
                      ) : (
                        <span className="faint">-</span>
                      )}
                    </td>
                    <td className="faint small">{c.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      </DataState>
    </div>
  );
}

export function FollowupsPage() {
  const { tab } = route.useSearch();
  const navigate = useNavigate({ from: '/followups' });
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
      <Tabs label="Follow-ups sections" tabs={[{ id: 'cadence', label: 'Cadence' }, { id: 'replies', label: 'Replies' }, { id: 'contacts', label: 'Contacts' }]} value={tab} onChange={(t: FollowupsTab) => void navigate({ search: { tab: t } })} />
      {tab === 'cadence' && <CadenceTab />}
      {tab === 'replies' && <RepliesTab />}
      {tab === 'contacts' && <ContactsTab />}
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

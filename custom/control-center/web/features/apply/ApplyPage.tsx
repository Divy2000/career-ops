import { useCallback, useState } from 'react';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { useApplication } from '../../lib/queries';
import { useEngine, sendTurn, type Target } from '../../lib/sessions';
import { useRunAction } from '../../lib/actions';
import { SessionPanel } from '../../components/SessionPanel';
import { Message } from '../../components/ActionBar';
import { Pill } from '../../components/ui';

const rowRoute = getRouteApi('/apply/$n');

export interface AnswerField {
  id: string;
  label: string;
  type: string;
  options?: string[];
  required: boolean;
  value: string;
  needsConfirmation: boolean;
}

export function AnswersForm({ fields, onChange }: { fields: AnswerField[]; onChange: (fields: AnswerField[]) => void }) {
  const set = (id: string, value: string) => onChange(fields.map((f) => (f.id === id ? { ...f, value } : f)));
  return (
    <div className="stack" aria-label="Drafted answers">
      {fields.map((f) => (
        <label key={f.id} className="stack" style={{ gap: 4 }}>
          <span>
            {f.label} {f.required && <span className="faint">(required)</span>} {f.needsConfirmation && <Pill tone="warn">needs your confirmation</Pill>}
          </span>
          {f.type === 'select' && f.options ? (
            <select value={f.value} onChange={(e) => set(f.id, e.target.value)}>
              {f.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : f.type === 'textarea' ? (
            <textarea rows={4} value={f.value} onChange={(e) => set(f.id, e.target.value)} />
          ) : (
            <input value={f.value} onChange={(e) => set(f.id, e.target.value)} />
          )}
        </label>
      ))}
    </div>
  );
}

function ApplyBody({ n, postingUrl }: { n: string | null; postingUrl: string }) {
  const navigate = useNavigate();
  const engine = useEngine();
  const [url, setUrl] = useState(postingUrl);
  const [fields, setFields] = useState<AnswerField[] | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState('queued');
  const [fillNote, setFillNote] = useState<string | null>(null);
  const actions = useRunAction();
  const playwright = engine.data?.playwrightAvailable ?? false;
  const onEnvelope = useCallback((kind: string, payload: unknown) => {
    if (kind === 'answers') setFields((payload as { fields: AnswerField[] }).fields);
  }, []);
  const onStatus = useCallback((s: string) => setStatus(s), []);
  const target: Target = n ? { type: 'app', value: n } : { type: 'url', value: url };

  const fill = async () => {
    if (!sessionId || !fields) return;
    const confirmed = fields.map(({ id, label, value }) => ({ id, label, value }));
    setFillNote(null);
    try {
      await sendTurn(sessionId, `The user confirmed these answers. Fill the real form with exactly these values, attach the tailored CV, stop before Submit and report what you filled:\n${JSON.stringify({ fields: confirmed })}`);
      setFillNote('Fill turn sent with your edited answers.');
    } catch (err) {
      setFillNote(`Could not send the fill turn: ${(err as Error).message}`);
    }
  };

  return (
    <>
      <div className="banner" role="status">
        Never submits. You press Submit.
        {!playwright && engine.data && <span> Playwright MCP has not been probed on this machine, so this page drafts answers only; the headed browser fill is disabled until the launch probe passes.</span>}
      </div>
      <div className="apply-grid">
        <div className="stack">
          <div className="card">
            <h2>Posting</h2>
            <label>
              URL <input aria-label="Posting URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." disabled={Boolean(sessionId)} />
            </label>
            <div className="row gap" style={{ marginTop: 8 }}>
              <button type="button" disabled={!url || actions.busy !== null} onClick={() => void actions.run('docs.prepareApplication', { url }, 'Zero-token prefill started; see Runs for its output.')}>
                Zero-token prefill <Pill tone="info">Network</Pill>
              </button>
              {n && (
                <button type="button" disabled={actions.busy !== null} onClick={() => void actions.run('tracker.setStatus', { row: Number(n), state: 'Applied' }, 'Marked as Applied')}>
                  Mark applied
                </button>
              )}
              <button type="button" onClick={() => void navigate({ to: n ? '/tracker/$n' : '/tracker', params: n ? { n } : undefined })}>
                Leave
              </button>
            </div>
            <Message message={actions.message} />
          </div>
        </div>
        <div className="stack">
          <div className="card">
            <h2>Answers</h2>
            {fields ? (
              <>
                <AnswersForm fields={fields} onChange={setFields} />
                <div className="row gap" style={{ marginTop: 12 }}>
                  <button type="button" disabled={!playwright || status === 'running' || status === 'queued'} title={playwright ? 'Sends the edited answers as the next turn; the browser stays headed and stops before Submit' : 'Disabled: Playwright MCP is not available on this machine'} onClick={() => void fill()}>
                    Fill real form
                  </button>
                  {!playwright && <span className="faint small">Drafting only on this machine.</span>}
                </div>
                {fillNote && <p className="muted small">{fillNote}</p>}
              </>
            ) : (
              <p className="muted">Start the session on the right with Draft answers. The answers envelope renders here as an editable form.</p>
            )}
          </div>
        </div>
        <SessionPanel
          mode="apply"
          title="Apply session"
          target={target}
          initialPrompt={url ? `Read the application form at ${url}, draft every answer from my CV and profile, and emit the answers envelope. Do not fill anything yet.` : ''}
          startLabel="Draft answers"
          onEnvelope={onEnvelope}
          onStatus={onStatus}
          onSessionId={setSessionId}
          replyLabel="Send"
        />
      </div>
    </>
  );
}

export function ApplyPage() {
  return (
    <section aria-labelledby="page-title">
      <div className="page-header">
        <h1 id="page-title">Apply</h1>
      </div>
      <ApplyBody n={null} postingUrl="" />
    </section>
  );
}

export function ApplyRowPage() {
  const { n } = rowRoute.useParams();
  const q = useApplication(n);
  return (
    <section aria-labelledby="page-title">
      <p>
        <Link to="/tracker/$n" params={{ n }}>
          Back to application
        </Link>
      </p>
      <div className="page-header">
        <h1 id="page-title">Apply: {q.data?.row.company ?? `row #${n}`}</h1>
        {q.data && <span className="muted">{q.data.row.role}</span>}
      </div>
      {q.data ? <ApplyBody key={n} n={n} postingUrl={q.data.row.url ?? ''} /> : <p className="muted">Loading the tracker row.</p>}
    </section>
  );
}

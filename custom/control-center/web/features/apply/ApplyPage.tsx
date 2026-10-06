import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { apiGet } from '../../lib/api';
import { useApplication } from '../../lib/queries';
import { useEngine, sendTurn, startTailoredCvSession, type Target } from '../../lib/sessions';
import { describeError, useRunAction } from '../../lib/actions';
import { SessionPanel } from '../../components/SessionPanel';
import { CostPill, Message } from '../../components/ActionBar';
import { DataState, Pill } from '../../components/ui';
import { prefillBlockers } from './prefill';
import type { ApplyDocuments } from '@shared/api';

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
              {/* Without an option for the held value the browser shows the first option, while the held value is what Fill sends. */}
              {!f.options.includes(f.value) && <option value={f.value}>{f.value === '' ? 'Choose an answer' : f.value}</option>}
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

function ApplyBody({ n, company, postingUrl }: { n: string | null; company: string | null; postingUrl: string }) {
  const navigate = useNavigate();
  const engine = useEngine();
  const [url, setUrl] = useState(postingUrl);
  const [fields, setFields] = useState<AnswerField[] | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState('queued');
  const [fillNote, setFillNote] = useState<string | null>(null);
  const actions = useRunAction();
  const docs = useQuery({ queryKey: ['apply', 'documents', n], queryFn: () => apiGet<ApplyDocuments>(n ? `/api/apply/documents?n=${n}` : '/api/apply/documents') });
  // null until the user picks, so the row's tailored CV and cover letter are preselected once the listing arrives.
  const [pickedPdf, setPickedPdf] = useState<string | null>(null);
  const [pickedCover, setPickedCover] = useState<string | null>(null);
  const pdf = pickedPdf ?? docs.data?.suggestedPdf ?? '';
  const cover = pickedCover ?? docs.data?.suggestedCover ?? '';
  const [summary, setSummary] = useState<string | null>(null);
  const blockers = prefillBlockers({ url, pdf, pdfCount: docs.data?.pdfs.length ?? 0, company });
  const playwright = engine.data?.playwrightAvailable ?? false;
  const onEnvelope = useCallback((kind: string, payload: unknown) => {
    if (kind === 'answers') setFields((payload as { fields: AnswerField[] }).fields);
  }, []);
  const onStatus = useCallback((s: string) => setStatus(s), []);
  const target: Target = n ? { type: 'app', value: n } : { type: 'url', value: url };
  // The documents picked on this page are the ones the session attaches, not whichever CV the apply mode would resolve.
  const chosen = pdf ? ` The CV PDF I will attach is ${pdf}${cover ? ` and the cover letter text is ${cover}` : ''}; draft the answers to match it.` : '';

  const prefill = async () => {
    setSummary(null);
    const out = await actions.run('docs.prepareApplication', { url, pdf, ...(cover ? { cover } : {}) }, 'Prefill summary ready below.');
    if (out && 'result' in out) setSummary(String(out.result).trim());
  };

  const generatePdf = async () => {
    if (!n) return;
    try {
      const m = await startTailoredCvSession(n);
      await navigate({ to: '/sessions/$id', params: { id: m.id } });
    } catch (err) {
      actions.setMessage({ tone: 'danger', text: `Could not start the tailored CV session: ${describeError(err)}` });
    }
  };

  const fill = async () => {
    if (!sessionId || !fields) return;
    const confirmed = fields.map(({ id, label, value }) => ({ id, label, value }));
    setFillNote(null);
    try {
      const attach = pdf ? `attach the CV PDF ${pdf}${cover ? ` and use the cover letter text in ${cover}` : ''}` : 'attach the tailored CV';
      await sendTurn(sessionId, `The user confirmed these answers. Fill the real form with exactly these values, ${attach}, stop before Submit and report what you filled:\n${JSON.stringify({ fields: confirmed })}`);
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
            {docs.isError && (
              <p role="alert" className="danger-text">
                Could not list the PDFs in output/: {describeError(docs.error)}
              </p>
            )}
            {docs.data && (
              <>
                <label style={{ display: 'block', marginTop: 8 }}>
                  CV PDF to attach{' '}
                  <select aria-label="CV PDF to attach" value={pdf} onChange={(e) => setPickedPdf(e.target.value)}>
                    <option value="">Choose a PDF</option>
                    {docs.data.pdfs.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
                {docs.data.covers.length > 0 && (
                  <label style={{ display: 'block', marginTop: 8 }}>
                    Cover letter text{' '}
                    <select aria-label="Cover letter text" value={cover} onChange={(e) => setPickedCover(e.target.value)}>
                      <option value="">None</option>
                      {docs.data.covers.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            )}
            <div className="row gap" style={{ marginTop: 8 }}>
              <button type="button" disabled={!docs.data || blockers.reasons.length > 0 || actions.busy !== null} aria-describedby={docs.data && blockers.reasons.length > 0 ? 'prefill-blockers' : undefined} onClick={() => void prefill()}>
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
            {docs.data && blockers.reasons.length > 0 && (
              <div id="prefill-blockers" className="stack" style={{ gap: 4, marginTop: 8 }}>
                {blockers.reasons.map((r) => (
                  <p key={r} className="muted small">
                    {r}
                  </p>
                ))}
                {blockers.needsPdf && n && (
                  <div>
                    <button type="button" onClick={() => void generatePdf()}>
                      Generate CV PDF <CostPill cost="tokens" />
                    </button>
                  </div>
                )}
                {blockers.needsPdf && !n && docs.data.pdfs.length === 0 && (
                  <p className="small">
                    <Link to="/tracker">Open the Tracker</Link>
                  </p>
                )}
              </div>
            )}
            <Message message={actions.message} />
            {summary !== null && (
              <pre tabIndex={0} aria-label="Prefill summary" className="log mono small" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {summary}
              </pre>
            )}
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
          initialPrompt={url ? `Read the application form at ${url}, draft every answer from my CV and profile, and emit the answers envelope. Do not fill anything yet.${chosen}` : ''}
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
      <ApplyBody n={null} company={null} postingUrl="" />
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
      <DataState query={q}>{q.data && <ApplyBody key={n} n={n} company={q.data.row.company} postingUrl={q.data.row.url ?? ''} />}</DataState>
    </section>
  );
}

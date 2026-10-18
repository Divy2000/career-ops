import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { ApiError, apiGet } from '../../lib/api';
import { useApplication } from '../../lib/queries';
import { useEngine, useSessionStream, useSessions, sendTurn, startTailoredCvSession, type Target } from '../../lib/sessions';
import { useRememberedSession } from '../../lib/useRememberedSession';
import { lastSession } from '../../lib/lastSession';
import { UnsavedProvider, useUnsaved } from '../../lib/unsaved';
import { describeError, useRunAction } from '../../lib/actions';
import { SessionPanel } from '../../components/SessionPanel';
import { useConfirm } from '../../components/ConfirmDialog';
import { CostPill, Message } from '../../components/ActionBar';
import { DataState, Pill } from '../../components/ui';
import { prefillBlockers } from './prefill';
import { rowIdentity, sameRow, type RowIdentity } from '../tracker/StatusControl';
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

// The fill turn leaves checkbox and radio groups to the candidate (modes/apply.md: on Lever a scripted click on one
// raises hCaptcha), so the app never sets them: they are listed as steps to do on the form, and the fill turn skips them.
const MANUAL_TYPES = new Set(['checkbox', 'radio']);
// A single checkbox (consent) or a group whose options were not listed counts too: the fill turn skips it all the same.
const isManualField = (f: AnswerField): boolean => MANUAL_TYPES.has(f.type);

// A pdf session still owns its row's CV: a second paid session for the same row must not start beside it (AskDrawer's
// generatePdf guard reads the same statuses from the sessions list).
const LIVE_PDF = new Set(['queued', 'running', 'awaiting_user']);

export function AnswersForm({ fields, onChange }: { fields: AnswerField[]; onChange: (fields: AnswerField[]) => void }) {
  const set = (id: string, value: string) => onChange(fields.map((f) => (f.id === id ? { ...f, value } : f)));
  return (
    <div className="stack" aria-label="Drafted answers">
      {fields.map((f) =>
        isManualField(f) ? (
          <div key={f.id} className="stack" style={{ gap: 4 }} data-manual-field={f.id}>
            <span>
              {f.label} {f.required && <span className="faint">(required)</span>} <Pill tone="warn">Set this on the form yourself</Pill>
            </span>
            {f.options && f.options.length > 0 && (
              <ul className="small" style={{ margin: 0 }}>
                {f.options.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
            )}
            {f.value && <span className="muted small">Drafted: {f.value}</span>}
          </div>
        ) : (
            <label key={f.id} className="stack" style={{ gap: 4 }}>
              <span>
                {f.label} {f.required && <span className="faint">(required)</span>} {f.needsConfirmation && <Pill tone="warn">needs your confirmation</Pill>}
              </span>
              {/* Any other fixed set of choices is a select, whatever the form called its control (combobox, dropdown): a typed value could match none of them. */}
              {f.options && f.options.length > 0 ? (
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
        ),
      )}
    </div>
  );
}

// The row's tracker status: Mark applied is not offered once the row is Applied, and asks before it moves a row back
// from a later stage.
// identity: the row shown under n, which Mark applied names so a different row a reindex moved under n is refused.
type ApplyBodyProps = { n: string | null; company: string | null; postingUrl: string; status?: string; identity?: RowIdentity };

/** Statuses a row reaches only after it was applied to: Mark applied would move it back. */
const PAST_APPLIED = ['Responded', 'Interview', 'Offer', 'Hired', 'Rejected'];

/** Leaving the page with edited answers asks first: the session keeps only the answers as it drafted them. */
export function ApplyBody(props: ApplyBodyProps) {
  // New draft remounts the form, so the URL, the answers and the panel start clean.
  const [draft, setDraft] = useState(0);
  // Stable, so the form's status callback (which the panel's effect depends on) does not change on every render.
  const onNewDraft = useCallback(() => setDraft((d) => d + 1), []);
  return (
    <UnsavedProvider>
      <ApplyForm key={draft} {...props} onNewDraft={onNewDraft} />
    </UnsavedProvider>
  );
}

const applyKey = (n: string | null) => `cc.apply.${n ?? 'url'}`;

// The apply link typed for a draft, by its session id: a row's session targets the row, not the link, so the link is
// kept beside it for a re-attached draft (prefill uses it). sessionStorage, like the remembered session itself.
const typedUrlKey = (sid: string) => `cc.apply.typedUrl.${sid}`;
function readTypedUrl(sid: string | null): string | null {
  if (!sid) return null;
  try {
    return sessionStorage.getItem(typedUrlKey(sid));
  } catch {
    return null;
  }
}
function writeTypedUrl(sid: string, url: string | null): void {
  try {
    if (url === null) sessionStorage.removeItem(typedUrlKey(sid));
    else sessionStorage.setItem(typedUrlKey(sid), url);
  } catch {
    // storage refused: only the link's re-attaching is lost
  }
}

// The CV PDF and cover letter a draft's prompt named, by its session id, so a re-attached draft fills with the documents
// its answers were drafted for, not the row's suggested ones. '' is an explicit "none"; null is no choice made, which
// leaves room for a document generated since.
type DraftDocs = { pdf: string | null; cover: string | null };
const draftDocsKey = (sid: string) => `cc.apply.docs.${sid}`;
function readDraftDocs(sid: string | null): DraftDocs | null {
  if (!sid) return null;
  try {
    const raw = sessionStorage.getItem(draftDocsKey(sid));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<DraftDocs>;
    const pick = (v: unknown) => (typeof v === 'string' ? v : null);
    return { pdf: pick(parsed.pdf), cover: pick(parsed.cover) };
  } catch {
    return null;
  }
}
function writeDraftDocs(sid: string, docs: DraftDocs | null): void {
  try {
    if (docs === null) sessionStorage.removeItem(draftDocsKey(sid));
    else sessionStorage.setItem(draftDocsKey(sid), JSON.stringify(docs));
  } catch {
    // storage refused: only the documents' re-attaching is lost
  }
}

// The application a row's session was started for, by its session id. A tracker number is reused once its row is
// deleted (the next addition takes max + 1), so a session remembered under the number is the shown row's only while the
// row is still that application. A session with none kept (started elsewhere) is taken as the row's.
const sessionRowKey = (sid: string) => `cc.apply.row.${sid}`;
function readSessionRow(sid: string): RowIdentity | null {
  try {
    const raw = sessionStorage.getItem(sessionRowKey(sid));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<RowIdentity>;
    if (typeof parsed.company !== 'string' || typeof parsed.role !== 'string' || !(parsed.report === null || typeof parsed.report === 'number')) return null;
    return { company: parsed.company, role: parsed.role, report: parsed.report };
  } catch {
    return null;
  }
}
function writeSessionRow(sid: string, row: RowIdentity | null): void {
  try {
    if (row === null) sessionStorage.removeItem(sessionRowKey(sid));
    else sessionStorage.setItem(sessionRowKey(sid), JSON.stringify(rowIdentity(row)));
  } catch {
    // storage refused: a reused number's session is only taken as the row's
  }
}
/** Whether the session was started for another application than `identity`, the one now under its row number. */
function startedForOther(sid: string | null, identity: RowIdentity | undefined): boolean {
  if (!sid || !identity) return false;
  const row = readSessionRow(sid);
  return row !== null && !sameRow(row, identity);
}

function ApplyForm({ n, company, postingUrl, status: rowStatus, identity, onNewDraft }: ApplyBodyProps & { onNewDraft: () => void }) {
  const navigate = useNavigate();
  const engine = useEngine();
  // The draft is a paid session and Fill is reachable only here: the row's last apply session is re-attached when the
  // page comes back, and its answers envelope (replayed by the panel) rebuilds the form.
  const remembered = useRememberedSession(applyKey(n));
  const rememberedId = remembered.panel.sessionId;
  // Another application's draft under a reused number is not this row's: it is let go, and the form starts clean, as New
  // draft's does. The number can change owner while the page is open (a delete elsewhere reindexes the tracker), and the
  // answers drafted for the earlier application must not stay for Fill to send to the new owner's session.
  const foreignDraft = n !== null && startedForOther(rememberedId, identity);
  const sessionId = foreignDraft ? null : rememberedId;
  useEffect(() => {
    if (!foreignDraft || !rememberedId) return;
    lastSession(applyKey(n)).forget(rememberedId);
    writeTypedUrl(rememberedId, null);
    writeDraftDocs(rememberedId, null);
    writeSessionRow(rememberedId, null);
    onNewDraft();
  }, [foreignDraft, rememberedId, n, onNewDraft]);
  const [typedUrl, setUrl] = useState<string | null>(null);
  const storedUrl = readTypedUrl(sessionId);
  // A session re-attached on /apply (no row), also one that reports its id after the page came back mid-start, brings
  // back its posting URL, which it carries as its target. One started from a typed URL already shows it.
  const attached = useSessionStream(n === null && typedUrl === null && storedUrl === null ? sessionId : null).meta?.target;
  // A link pasted from an email often carries a space or newline; the server refuses it untrimmed, so every use trims.
  const shownUrl = typedUrl ?? storedUrl ?? (attached?.type === 'url' && attached.value ? attached.value : postingUrl);
  const url = useMemo(() => shownUrl.trim(), [shownUrl]);
  const [fields, setFields] = useState<AnswerField[] | null>(null);
  const [drafted, setDrafted] = useState<AnswerField[] | null>(null);
  const edited = fields !== null && JSON.stringify(fields) !== JSON.stringify(drafted);
  useUnsaved('the edited answers', edited);
  const confirm = useConfirm();
  // The draft stays on the Sessions page; this page lets go of it and offers the start form again.
  // Confirms queue, so a second click while one is asking or writing would ask twice: it is ignored.
  const asking = useRef(false);
  const newDraft = async (...args: Parameters<typeof newDraftAsked>) => {
    if (asking.current) return;
    asking.current = true;
    try {
      await newDraftAsked(...args);
    } finally {
      asking.current = false;
    }
  };
  const newDraftAsked = async () => {
    if (edited && !(await confirm({ title: 'Discard the edited answers?', body: 'A new draft starts from an empty form. The current draft stays on the Sessions page with the answers as it drafted them.', confirmLabel: 'Discard changes', danger: true }))) return;
    lastSession(applyKey(n)).write(null);
    if (sessionId) {
      writeTypedUrl(sessionId, null);
      writeDraftDocs(sessionId, null);
      writeSessionRow(sessionId, null);
    }
    onNewDraft();
  };
  const [status, setStatus] = useState('queued');
  const [fillNote, setFillNote] = useState<string | null>(null);
  const actions = useRunAction();
  // A second click while the confirm is open would ask twice: it is ignored, as New draft's is.
  const marking = useRef(false);
  const markApplied = async () => {
    if (marking.current) return;
    marking.current = true;
    try {
      if (rowStatus && PAST_APPLIED.includes(rowStatus) && !(await confirm({ title: 'Move this row back to Applied?', body: `The row is at ${rowStatus}. Marking it applied replaces that status, and follow-ups count from Applied again.`, confirmLabel: 'Mark applied', danger: true }))) return;
      if (!identity) return;
      await actions.run('tracker.setStatus', { row: Number(n), state: 'Applied', expectCompany: identity.company, expectRole: identity.role, expectReport: identity.report }, 'Marked as Applied');
    } finally {
      marking.current = false;
    }
  };
  const docs = useQuery({ queryKey: ['apply', 'documents', n], queryFn: () => apiGet<ApplyDocuments>(n ? `/api/apply/documents?n=${n}` : '/api/apply/documents') });
  // null until the user picks, so the row's tailored CV and cover letter are preselected once the listing arrives.
  const [pickedPdf, setPickedPdf] = useState<string | null>(null);
  const [pickedCover, setPickedCover] = useState<string | null>(null);
  // The latest picks, for a start whose id comes back through the callback of an earlier render.
  const latestPicks = useRef<DraftDocs>({ pdf: null, cover: null });
  const storedDocs = readDraftDocs(sessionId);
  // A draft that made no choice, or named a file no longer in output/, leaves the choice open, so the listing's
  // suggestion is preselected rather than a file Fill could not attach. Until the listing answers, the draft's own
  // choice stands.
  const stored = (v: string | null | undefined, listed: string[] | undefined) => (v === '' || (v && (!listed || listed.includes(v))) ? v : null);
  const storedPdf = stored(storedDocs?.pdf, docs.data?.pdfs);
  const storedCover = stored(storedDocs?.cover, docs.data?.covers);
  const pdf = pickedPdf ?? storedPdf ?? docs.data?.suggestedPdf ?? '';
  const cover = pickedCover ?? storedCover ?? docs.data?.suggestedCover ?? '';
  // The panel's start holds the callback of the render it was sent from, so the link and documents kept are the ones its
  // prompt used, also when the id comes back after this form unmounted.
  const rememberSessionId = remembered.panel.onSessionId;
  const onSessionId = useCallback(
    (sid: string) => {
      // A fork of a re-attached draft carries the draft's link on, as it does its documents.
      const link = typedUrl ?? (sid !== sessionId ? storedUrl : null);
      if (link !== null) writeTypedUrl(sid, link.trim());
      // Only the user's picks are kept: a preselected suggestion is no choice, so a newer tailored file is preselected
      // when the page comes back. A reply reports the draft it runs in: its prompt named no documents, so the draft's
      // own are left as they are. A fork of a re-attached draft carries the draft's choices on.
      if (sid !== sessionId) {
        writeDraftDocs(sid, { pdf: latestPicks.current.pdf ?? storedPdf, cover: latestPicks.current.cover ?? storedCover });
        if (n !== null && identity) writeSessionRow(sid, identity);
      }
      rememberSessionId(sid);
    },
    [typedUrl, storedUrl, sessionId, storedPdf, storedCover, rememberSessionId, n, identity],
  );
  // A pick made after the draft started is the one Fill attaches, so it is kept for the re-attached draft as well.
  const pickDoc = (kind: keyof DraftDocs, value: string) => {
    (kind === 'pdf' ? setPickedPdf : setPickedCover)(value);
    latestPicks.current = { ...latestPicks.current, [kind]: value };
    if (sessionId) writeDraftDocs(sessionId, { pdf: pickedPdf ?? storedPdf, cover: pickedCover ?? storedCover, [kind]: value });
  };
  const [summary, setSummary] = useState<string | null>(null);
  const blockers = prefillBlockers({ url, pdf, cover, pdfCount: docs.data?.pdfs.length ?? 0, company });
  const playwright = engine.data?.playwrightAvailable ?? false;
  const onEnvelope = useCallback((kind: string, payload: unknown) => {
    if (kind !== 'answers') return;
    const next = (payload as { fields: AnswerField[] }).fields;
    setFields(next);
    setDrafted(next);
  }, []);
  // Counts the statuses the stream delivered, so a late answer to a turn POST cannot overwrite a newer one.
  const statusSeq = useRef(0);
  const latestStatus = useRef(status);
  const rememberStatus = remembered.panel.onStatus;
  const onStatus = useCallback(
    (s: string) => {
      statusSeq.current += 1;
      latestStatus.current = s;
      setStatus(s);
      rememberStatus(s);
      // Deleted elsewhere (or a stale id): its answers cannot be filled any more, so the form starts over like New draft.
      if (s === 'gone') {
        if (sessionId) {
          writeTypedUrl(sessionId, null);
          writeDraftDocs(sessionId, null);
          writeSessionRow(sessionId, null);
        }
        onNewDraft();
      }
    },
    [rememberStatus, onNewDraft, sessionId],
  );
  const target: Target = n ? { type: 'app', value: n } : { type: 'url', value: url };
  // The documents picked on this page are the ones the session attaches, not whichever CV the apply mode would resolve.
  const chosen = pdf ? ` The CV PDF I will attach is ${pdf}${cover ? ` and the cover letter text is ${cover}` : ''}; draft the answers to match it.` : '';

  const prefill = async () => {
    setSummary(null);
    const out = await actions.run('docs.prepareApplication', { url, pdf, ...(cover ? { cover } : {}) }, 'Prefill summary ready below.');
    if (out && 'result' in out) setSummary(String(out.result).trim());
  };

  // Each click starts a paid session that writes the row's CV, so the button stays off while the last one started here
  // (remembered across leaving the page, for the session page it opens) is starting, queued or running.
  const pdfSession = useRememberedSession(`cc.pdf.${n ?? 'none'}`);
  const pdfRemembered = n ? pdfSession.panel.sessionId : null;
  // Another application's CV run under a reused number neither holds Generate off nor is linked as this row's.
  const foreignPdf = startedForOther(pdfRemembered, identity);
  const pdfId = foreignPdf ? null : pdfRemembered;
  useEffect(() => {
    if (foreignPdf && pdfRemembered) lastSession(`cc.pdf.${n}`).forget(pdfRemembered);
  }, [foreignPdf, pdfRemembered, n]);
  const pdfStream = useSessionStream(pdfId);
  // The sessions list also backs the per-row tailored-CV guard: a pdf session for this row started from its Documents
  // tab (cc.application.<n>.documents) is not remembered under cc.pdf.<n>, so the guard reads it from the list, exactly
  // as AskDrawer's generatePdf does, and links it instead of starting a second paid CV write.
  const sessions = useSessions();
  // Until the sessions list answers (and when it cannot), a live pdf session for the row cannot be told apart from none,
  // so Generate stays off rather than starting a second paid CV write, as Today's Evaluate button guards oferta sessions.
  const sessionsChecking = sessions.isPending || sessions.isError;
  const livePdf = n === null ? undefined : sessions.data?.find((s) => s.mode === 'pdf' && LIVE_PDF.has(s.status) && s.target.value === n && !startedForOther(s.id, identity));
  const { onStatus: pdfOnStatus, onStarting: pdfOnStarting, onSessionId: pdfOnSessionId, onStartFailed: pdfOnStartFailed } = pdfSession.panel;
  useEffect(() => {
    // A session waiting for the user's reply is still the row's CV run: the reply finishes it, so it stays live here.
    if (pdfId) pdfOnStatus(pdfStream.gone ? 'gone' : pdfStream.transcript.status === 'awaiting_user' ? 'running' : pdfStream.transcript.status);
  }, [pdfId, pdfStream.gone, pdfStream.transcript.status, pdfOnStatus]);
  const [generating, setGenerating] = useState(false);
  // The start can answer after the user left the page: it is remembered under cc.pdf.<n> and linked here on return,
  // so only a still-mounted form opens its session page.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const generatePdf = async () => {
    if (!n) return;
    setGenerating(true);
    pdfOnStarting();
    try {
      const m = await startTailoredCvSession(n);
      if (identity) writeSessionRow(m.id, identity);
      pdfOnSessionId(m.id);
      if (mounted.current) await navigate({ to: '/sessions/$id', params: { id: m.id } });
    } catch (err) {
      pdfOnStartFailed();
      actions.setMessage({ tone: 'danger', text: `Could not start the tailored CV session: ${describeError(err)}` });
    } finally {
      setGenerating(false);
    }
  };

  // Busy from the click to the server's answer: the turn's running status arrives later, over the stream.
  const [filling, setFilling] = useState(false);
  const fill = async () => {
    if (!sessionId || !fields) return;
    const confirmed = fields.filter((f) => !isManualField(f)).map(({ id, label, value }) => ({ id, label, value }));
    const manual = fields.filter(isManualField).map((f) => JSON.stringify(f.label));
    const leave = manual.length > 0 ? ` Leave these to the user, who sets them on the form: ${manual.join(', ')}.` : '';
    setFillNote(null);
    setFilling(true);
    const seqAtClick = statusSeq.current;
    // Marked like a reply in the panel: the draft reads as finished until its stream shows the fill turn, and a page
    // mounted meanwhile must not offer New draft and a second apply session beside it.
    const { onStarting, onSessionId: reported, onStartFailed } = remembered.panel;
    const failed = () => {
      onStartFailed();
      // A turn refused because one started elsewhere meanwhile still runs: the status the stream gave is restated.
      rememberStatus(latestStatus.current);
    };
    onStarting();
    try {
      const attach = pdf ? `attach the CV PDF ${pdf}${cover ? ` and use the cover letter text in ${cover}` : ''}` : 'attach the tailored CV';
      const meta = await sendTurn(sessionId, `The user confirmed these answers. Fill the real form with exactly these values, ${attach}, stop before Submit and report what you filled.${leave}\nThe values to fill:\n${JSON.stringify({ fields: confirmed })}`);
      // The turn is running from here on, but its running event over the stream may come later and the button would
      // wake up. A status the stream already delivered since the click is newer than this answer, so it stays.
      if (statusSeq.current === seqAtClick) {
        setStatus(meta.status);
        rememberStatus(meta.status);
      }
      reported(meta.id);
      // A 202 can carry a turn that failed before it ran (no approved CLI, no token): nothing was sent.
      if (meta.status === 'error') failed();
      setFillNote(meta.status === 'error' ? `Could not send the fill turn: ${meta.error ?? 'the turn failed to start'}` : 'Fill turn sent with your edited answers.');
    } catch (err) {
      // Deleted elsewhere since the draft: the stream sends no event for that, so the 404 is the news that it is gone.
      if (err instanceof ApiError && err.status === 404) {
        onStartFailed();
        onStatus('gone');
        return;
      }
      failed();
      setFillNote(`Could not send the fill turn: ${describeError(err)}`);
    } finally {
      setFilling(false);
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
              URL <input aria-label="Posting URL" value={shownUrl} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." disabled={Boolean(sessionId)} />
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
                  <select aria-label="CV PDF to attach" value={pdf} onChange={(e) => pickDoc('pdf', e.target.value)}>
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
                    <select aria-label="Cover letter text" value={cover} onChange={(e) => pickDoc('cover', e.target.value)}>
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
              {n && identity && rowStatus !== 'Applied' && (
                <button type="button" disabled={actions.busy !== null} onClick={() => void markApplied()}>
                  Mark applied
                </button>
              )}
              {sessionId && !remembered.busy && (
                <button type="button" title="Lets go of this draft (it stays on the Sessions page) and offers the start form again" onClick={() => void newDraft()}>
                  New draft
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
                    <button type="button" disabled={generating || pdfSession.busy || livePdf !== undefined || sessionsChecking} onClick={() => void generatePdf()}>
                      Generate CV PDF <CostPill cost="tokens" />
                    </button>
                    {/* While another mount's start is in flight, the remembered id is still the earlier, finished session. */}
                    {/* Nor while this page's own start is in flight. */}
                    {livePdf?.id || (pdfSession.busy && !pdfSession.waiting && !generating && pdfId) ? (
                      <span className="muted small">
                        {' '}
                        <Link to="/sessions/$id" params={{ id: livePdf?.id ?? pdfId! }}>
                          The tailored CV session
                        </Link>{' '}
                        is still running.
                      </span>
                    ) : (
                      (pdfSession.waiting || generating) && <span className="muted small"> The tailored CV session is starting.</span>
                    )}
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
                  <button type="button" disabled={filling || remembered.busy || !playwright || status === 'running' || status === 'queued'} title={playwright ? 'Sends the edited answers as the next turn; the browser stays headed and stops before Submit' : 'Disabled: Playwright MCP is not available on this machine'} onClick={() => void fill()}>
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
        {remembered.waiting && sessionId === null ? (
          // Left mid-start: the draft is still being created, and a second Draft answers would start a second paid session.
          // A draft that exists (a reply to it in flight) keeps its panel.
          <div className="card session" role="status">
            <h2 style={{ margin: 0 }}>
              Apply session <Pill tone="warn">Uses tokens</Pill>
            </h2>
            <p className="muted" style={{ margin: 'var(--space-2) 0 0' }}>
              Starting the apply session. It shows here once it is created.
            </p>
          </div>
        ) : (
          // Another mount's reply or Fill to this draft is in flight: a second one would be refused beside it, and the
          // refusal would let go of the first one's start mark. Always wrapped, so holding it does not remount the panel.
          <fieldset disabled={remembered.waiting} className="turn-hold">
            <SessionPanel
              key={remembered.panelKey}
              sessionId={sessionId}
              mode="apply"
              title="Apply session"
              target={target}
              initialPrompt={url ? `Read the application form at ${url}, draft every answer from my CV and profile, and emit the answers envelope. Do not fill anything yet.${chosen}` : ''}
              startLabel="Draft answers"
              onEnvelope={onEnvelope}
              onStatus={onStatus}
              onSessionId={onSessionId}
              onStartFailed={remembered.panel.onStartFailed}
              onStarting={remembered.panel.onStarting}
              marksTurnStarts
              replyLabel="Send"
            />
          </fieldset>
        )}
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
      <DataState query={q}>{q.data && <ApplyBody key={n} n={n} company={q.data.row.company} postingUrl={q.data.row.url ?? ''} status={q.data.row.status} identity={rowIdentity(q.data.row)} />}</DataState>
    </section>
  );
}

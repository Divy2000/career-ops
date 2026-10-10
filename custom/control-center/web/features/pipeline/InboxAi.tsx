import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { SessionPanel } from '../../components/SessionPanel';
import { Pill } from '../../components/ui';
import { useConfirm } from '../../components/ConfirmDialog';
import { fanOut, useSessions } from '../../lib/sessions';
import { usePipeline } from '../../lib/queries';
import { evaluatingTargets } from './evaluating';
import { describeError } from '../../lib/actions';
import { BATCH_MAX_URLS, FANOUT_CONFIRM_ABOVE } from '@shared/fanout';
import { fanoutOutcome } from '../../lib/fanoutOutcome';
import { useRememberedSession } from '../../lib/useRememberedSession';

/**
 * Process inbox runs pipeline mode over data/pipeline.md, whose liveness sweep puts every pending row in the file it
 * hands check-liveness.mjs; the guard refuses a line that is not an http(s) URL, which fails the sweep. Saved-JD rows
 * (local:jds/) are left out, and each is evaluated from its own row (Evaluate JD).
 */
// A session waiting for the user's reply still owns the rows it works on: answering it carries on.
const LIVE = new Set(['queued', 'running', 'awaiting_user']);

export const PROCESS_INBOX_PROMPT =
  'Process the pending pipeline rows following the pipeline mode: triage, evaluate the strong matches and write their reports. Leave every local:jds/ row out of this run: not in the liveness sweep (its URL file takes http(s) URLs only) and not processed. Those rows stay pending; each is evaluated from its saved JD on its own.';

/**
 * Pipeline AI entry points: Process inbox (pipeline mode) and Evaluate the visible pending rows as a fan-out (spec 4.2).
 * Both take posting URLs only; `savedJds` counts the visible rows that are a saved JD (local:jds/), which are evaluated
 * from their own row instead.
 */
export function InboxAi({ urls, savedJds = 0, evaluating = 0, onFanOut, checking = false, uncheckable = false }: { urls: string[]; savedJds?: number; evaluating?: number; onFanOut?: () => void; checking?: boolean; uncheckable?: boolean }) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  // The pipeline session is paid and edits data/pipeline.md: the last one is re-attached when the page comes back, and
  // while it is starting, queued or running the button shows it instead of closing it, so a second one cannot start.
  const process = useRememberedSession('cc.pipeline.process');
  const [open, setOpen] = useState(process.panel.sessionId !== null);
  // New run lets go of the finished run (it stays on the Sessions page) and remounts the panel on its start form.
  const [fresh, setFresh] = useState(0);
  // The run's own status: one waiting for the user's reply still owns the inbox (the reply carries it on), so it offers
  // no New run beside it.
  const [processStatus, setProcessStatus] = useState<string | null>(null);
  const rememberProcessStatus = process.panel.onStatus;
  const onProcessStatus = useCallback(
    (s: string) => {
      setProcessStatus(s);
      rememberProcessStatus(s);
    },
    [rememberProcessStatus],
  );
  // This panel's own start, from the click until the server answers: its session is in no list yet.
  const [startingHere, setStartingHere] = useState(false);
  const { onStarting: markStarting, onStartFailed: markStartFailed, onSessionId: rememberProcessId } = process.panel;
  const onProcessStarting = useCallback(() => {
    setStartingHere(true);
    markStarting();
  }, [markStarting]);
  const onProcessStartFailed = useCallback(() => {
    setStartingHere(false);
    markStartFailed();
  }, [markStartFailed]);
  const onProcessId = useCallback(
    (id: string) => {
      setStartingHere(false);
      rememberProcessId(id);
    },
    [rememberProcessId],
  );
  // The session New run let go of: a sessions list read before it ended may still list it as live.
  const [letGo, setLetGo] = useState<string | null>(null);
  const newRun = () => {
    setLetGo(process.panel.sessionId);
    setProcessStatus(null);
    // Letting go is what a deleted session gets: the store forgets it and no session is attached.
    process.panel.onStatus('gone');
    setFresh((n) => n + 1);
  };
  const [note, setNote] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  // Process inbox evaluates every pending row, and an evaluation started for one of them would evaluate, report and
  // bill it a second time: while either runs, the other does not start.
  const sessions = useSessions();
  const livePipeline = (sessions.data ?? []).find((s) => s.mode === 'pipeline' && LIVE.has(s.status) && s.id !== letGo)?.id ?? null;
  const pipelineLive = process.busy || startingHere || livePipeline !== null;
  // The remembered session is this browser tab's only: a live one started in another tab (or before this tab was
  // reopened) is re-attached, so the button shows it instead of a start form for a second run.
  const { sessionId: processId, onSessionId: attachProcess } = process.panel;
  useEffect(() => {
    if (livePipeline !== null && processId === null && !process.waiting) attachProcess(livePipeline);
  }, [livePipeline, processId, process.waiting, attachProcess]);
  const pipeline = usePipeline();
  const beingEvaluated = evaluatingTargets(sessions.data);
  const pendingEvaluating = pipeline.data?.kind === 'ok' ? new Set(pipeline.data.rows.filter((r) => !r.done && beingEvaluated.has(r.url)).map((r) => r.url)).size : 0;
  // One fan-out takes at most BATCH_MAX_URLS. Splitting a bigger set into several requests would leave a partial start
  // when a later one fails, and the started rows stay pending, so a retry would evaluate them twice.
  const unique = [...new Set(urls)];
  const tooMany = unique.length > BATCH_MAX_URLS;
  // Busy from the click to the server's answer: the server dedupes URLs within one request only, so a second click
  // would start every evaluation again.
  const [busy, setBusy] = useState(false);
  // The disabled button lags the click by a render, and confirms queue: a second click before it would ask twice.
  const asking = useRef(false);
  const evaluateAll = async () => {
    if (unique.length === 0 || tooMany || asking.current) return;
    asking.current = true;
    setBusy(true);
    try {
      if (unique.length > FANOUT_CONFIRM_ABOVE && !(await confirm({ title: `Start ${unique.length} evaluation sessions?`, body: 'They run in parallel under the Claude slot cap. Each one uses tokens.', confirmLabel: 'Start them', focusCancel: true }))) return;
      const r = await fanOut('oferta', unique);
      const outcome = fanoutOutcome(r);
      setNote({ tone: outcome.failedUrls.length > 0 ? 'danger' : 'ok', text: outcome.text });
      // A session that did not start is reported here; the Sessions page would hide why.
      if (outcome.failedUrls.length === 0) await navigate({ to: '/sessions' });
    } catch (err) {
      setNote({ tone: 'danger', text: `Could not start the evaluations: ${describeError(err)}` });
    } finally {
      // Even a failed fan-out may have started some: the host reads the sessions list again to leave them out.
      onFanOut?.();
      asking.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <div className="toolbar" aria-label="Inbox AI actions">
        <button type="button" onClick={() => setOpen((o) => (process.busy ? true : !o))} aria-expanded={open}>
          Process inbox <Pill tone="warn">Uses tokens</Pill>
        </button>
        <button type="button" disabled={busy || checking || pipelineLive || unique.length === 0 || tooMany} onClick={() => void evaluateAll()} title={!tooMany && unique.length > FANOUT_CONFIRM_ABOVE ? 'Asks for confirmation above 3 sessions' : undefined}>
          Evaluate visible ({unique.length}) <Pill tone="warn">Uses tokens</Pill>
        </button>
        {pipelineLive && <span className="muted small">Process inbox is processing the pending rows, so Evaluate visible is off until it ends.</span>}
        {evaluating > 0 && <span className="muted small">{evaluating === 1 ? '1 row is already being evaluated and is left out.' : `${evaluating} rows are already being evaluated and are left out.`}</span>}
        {uncheckable && <span className="danger-text small">Could not check which rows are already being evaluated, so Evaluate visible is off until the sessions list loads.</span>}
        {savedJds > 0 && (
          <span className="muted small">
            {savedJds === 1 ? '1 row with a saved JD is left out of Evaluate visible and Process inbox: use Evaluate JD on its row.' : `${savedJds} rows with a saved JD are left out of Evaluate visible and Process inbox: use Evaluate JD on each row.`}
          </span>
        )}
        {tooMany && (
          <span className="danger-text small">
            At most {BATCH_MAX_URLS} evaluations at a time. Filter the list to {BATCH_MAX_URLS} or fewer pending rows.
          </span>
        )}
        {note && (
          <span role={note.tone === 'danger' ? 'alert' : 'status'} className={`small ${note.tone === 'danger' ? 'danger-text' : 'muted'}`}>
            {note.text}
          </span>
        )}
      </div>
      {open && process.shown && !process.busy && processStatus !== 'awaiting_user' && (
        <div className="row gap">
          <button type="button" onClick={newRun}>
            New run
          </button>
        </div>
      )}
      {open &&
        (!process.shown && (sessions.isPending || livePipeline !== null) ? (
          <p role="status" className="muted small">
            Checking for a Process inbox already running.
          </p>
        ) : !process.shown && sessions.isError ? (
          <p role="alert" className="danger-text small">
            Could not check for a running Process inbox, so it cannot start until the sessions list loads.
          </p>
        ) : !process.shown && (busy || pendingEvaluating > 0) ? (
          <p role="status" className="muted small">
            {busy ? 'Evaluations of the visible rows are starting' : pendingEvaluating === 1 ? '1 pending row is being evaluated' : `${pendingEvaluating} pending rows are being evaluated`}, and Process inbox would evaluate them again. It can start once they finish.
          </p>
        ) : (
          <SessionPanel key={`${process.panelKey}-${fresh}`} {...process.panel} onStatus={onProcessStatus} onStarting={onProcessStarting} onStartFailed={onProcessStartFailed} onSessionId={onProcessId} mode="pipeline" title="Process inbox" initialPrompt={PROCESS_INBOX_PROMPT} />
        ))}
    </div>
  );
}

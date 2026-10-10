import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { SessionPanel } from '../../components/SessionPanel';
import { Pill } from '../../components/ui';
import { useConfirm } from '../../components/ConfirmDialog';
import { fanOut } from '../../lib/sessions';
import { describeError } from '../../lib/actions';
import { BATCH_MAX_URLS, FANOUT_CONFIRM_ABOVE } from '@shared/fanout';
import { fanoutOutcome } from '../../lib/fanoutOutcome';
import { useRememberedSession } from '../../lib/useRememberedSession';

/**
 * Process inbox runs pipeline mode over data/pipeline.md, whose liveness sweep puts every pending row in the file it
 * hands check-liveness.mjs; the guard refuses a line that is not an http(s) URL, which fails the sweep. Saved-JD rows
 * (local:jds/) are left out, and each is evaluated from its own row (Evaluate JD).
 */
export const PROCESS_INBOX_PROMPT =
  'Process the pending pipeline rows following the pipeline mode: triage, evaluate the strong matches and write their reports. Leave every local:jds/ row out of this run: not in the liveness sweep (its URL file takes http(s) URLs only) and not processed. Those rows stay pending; each is evaluated from its saved JD on its own.';

/**
 * Pipeline AI entry points: Process inbox (pipeline mode) and Evaluate the visible pending rows as a fan-out (spec 4.2).
 * Both take posting URLs only; `savedJds` counts the visible rows that are a saved JD (local:jds/), which are evaluated
 * from their own row instead.
 */
export function InboxAi({ urls, savedJds = 0, evaluating = 0 }: { urls: string[]; savedJds?: number; evaluating?: number }) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  // The pipeline session is paid and edits data/pipeline.md: the last one is re-attached when the page comes back, and
  // while it is starting, queued or running the button shows it instead of closing it, so a second one cannot start.
  const process = useRememberedSession('cc.pipeline.process');
  const [open, setOpen] = useState(process.panel.sessionId !== null);
  const [note, setNote] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  // One fan-out takes at most BATCH_MAX_URLS. Splitting a bigger set into several requests would leave a partial start
  // when a later one fails, and the started rows stay pending, so a retry would evaluate them twice.
  const unique = [...new Set(urls)];
  const tooMany = unique.length > BATCH_MAX_URLS;
  // Busy from the click to the server's answer: the server dedupes URLs within one request only, so a second click
  // would start every evaluation again.
  const [busy, setBusy] = useState(false);
  const evaluateAll = async () => {
    if (unique.length === 0 || tooMany) return;
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
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <div className="toolbar" aria-label="Inbox AI actions">
        <button type="button" onClick={() => setOpen((o) => (process.busy ? true : !o))} aria-expanded={open}>
          Process inbox <Pill tone="warn">Uses tokens</Pill>
        </button>
        <button type="button" disabled={busy || unique.length === 0 || tooMany} onClick={() => void evaluateAll()} title={!tooMany && unique.length > FANOUT_CONFIRM_ABOVE ? 'Asks for confirmation above 3 sessions' : undefined}>
          Evaluate visible ({unique.length}) <Pill tone="warn">Uses tokens</Pill>
        </button>
        {evaluating > 0 && <span className="muted small">{evaluating === 1 ? '1 row is already being evaluated and is left out.' : `${evaluating} rows are already being evaluated and are left out.`}</span>}
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
      {open && <SessionPanel key={process.panelKey} {...process.panel} mode="pipeline" title="Process inbox" initialPrompt={PROCESS_INBOX_PROMPT} />}
    </div>
  );
}

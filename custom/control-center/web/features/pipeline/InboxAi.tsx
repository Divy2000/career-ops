import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { SessionPanel } from '../../components/SessionPanel';
import { Pill } from '../../components/ui';
import { useConfirm } from '../../components/ConfirmDialog';
import { fanOut } from '../../lib/sessions';
import { describeError } from '../../lib/actions';
import { BATCH_MAX_URLS } from '@shared/fanout';

export const FANOUT_CONFIRM_ABOVE = 3;

/** Pipeline AI entry points: Process inbox (pipeline mode) and Evaluate the visible pending rows as a fan-out (spec 4.2). */
export function InboxAi({ urls }: { urls: string[] }) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // One fan-out takes at most BATCH_MAX_URLS. Splitting a bigger set into several requests would leave a partial start
  // when a later one fails, and the started rows stay pending, so a retry would evaluate them twice.
  const unique = [...new Set(urls)];
  const tooMany = unique.length > BATCH_MAX_URLS;
  const evaluateAll = async () => {
    if (unique.length === 0 || tooMany) return;
    if (unique.length > FANOUT_CONFIRM_ABOVE && !(await confirm({ title: `Start ${unique.length} evaluation sessions?`, body: 'They run in parallel under the Claude slot cap. Each one uses tokens.', confirmLabel: 'Start them' }))) return;
    try {
      const r = await fanOut('oferta', unique);
      setNote(`Started ${r.sessions.length} evaluations with report numbers ${r.reserved.join(', ')}.`);
      await navigate({ to: '/sessions' });
    } catch (err) {
      setNote(`Could not start the evaluations: ${describeError(err)}`);
    }
  };
  return (
    <div className="stack">
      <div className="toolbar" aria-label="Inbox AI actions">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          Process inbox <Pill tone="warn">Uses tokens</Pill>
        </button>
        <button type="button" disabled={unique.length === 0 || tooMany} onClick={() => void evaluateAll()} title={!tooMany && unique.length > FANOUT_CONFIRM_ABOVE ? 'Asks for confirmation above 3 sessions' : undefined}>
          Evaluate visible ({unique.length}) <Pill tone="warn">Uses tokens</Pill>
        </button>
        {tooMany && (
          <span className="danger-text small">
            At most {BATCH_MAX_URLS} evaluations at a time. Filter the list to {BATCH_MAX_URLS} or fewer pending rows.
          </span>
        )}
        {note && (
          <span role="status" className="muted small">
            {note}
          </span>
        )}
      </div>
      {open && <SessionPanel mode="pipeline" title="Process inbox" initialPrompt="Process the pending pipeline rows following the pipeline mode: triage, evaluate the strong matches and write their reports." />}
    </div>
  );
}

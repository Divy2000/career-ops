import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { SessionPanel } from '../../components/SessionPanel';
import { Pill } from '../../components/ui';
import { useConfirm } from '../../components/ConfirmDialog';
import { fanOut } from '../../lib/sessions';
import { describeError } from '../../lib/actions';

export const FANOUT_CONFIRM_ABOVE = 3;

/** Pipeline AI entry points: Process inbox (pipeline mode) and Evaluate the visible pending rows as a fan-out (spec 4.2). */
export function InboxAi({ urls }: { urls: string[] }) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const evaluateAll = async () => {
    if (urls.length === 0) return;
    if (urls.length > FANOUT_CONFIRM_ABOVE && !(await confirm({ title: `Start ${urls.length} evaluation sessions?`, body: 'They run in parallel under the Claude slot cap. Each one uses tokens.', confirmLabel: 'Start them' }))) return;
    try {
      const r = await fanOut('oferta', urls);
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
        <button type="button" disabled={urls.length === 0} onClick={() => void evaluateAll()} title={urls.length > FANOUT_CONFIRM_ABOVE ? 'Asks for confirmation above 3 sessions' : undefined}>
          Evaluate visible ({urls.length}) <Pill tone="warn">Uses tokens</Pill>
        </button>
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

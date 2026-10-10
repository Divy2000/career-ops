import { useState } from 'react';
import { SessionPanel } from '../../components/SessionPanel';
import { Pill } from '../../components/ui';
import { useRememberedSession } from '../../lib/useRememberedSession';

/**
 * Tracker mode (spec 1c): a read-only analysis session over applications.md. Its last session (this browser tab) is
 * shown again when the Tracker comes back, so an answer still running is not lost by leaving the page.
 */
export function AskTrackerPanel() {
  const ask = useRememberedSession('cc.tracker.ask');
  const [open, setOpen] = useState(ask.shown);
  return (
    <div className="stack">
      <div className="row gap">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          Ask about tracker <Pill tone="warn">Uses tokens</Pill>
        </button>
      </div>
      {open && <SessionPanel key={ask.panelKey} {...ask.panel} mode="tracker" title="Ask about the tracker" placeholder="Which applications went cold? What should I follow up on this week?" draftKey="cc.tracker.ask.draft" />}
    </div>
  );
}

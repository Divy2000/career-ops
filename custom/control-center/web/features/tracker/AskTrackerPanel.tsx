import { useState } from 'react';
import { SessionPanel } from '../../components/SessionPanel';
import { Pill } from '../../components/ui';

/** Tracker mode (spec 1c): a read-only analysis session over applications.md. */
export function AskTrackerPanel() {
  const [open, setOpen] = useState(false);
  return (
    <div className="stack">
      <div className="row gap">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          Ask about tracker <Pill tone="warn">Uses tokens</Pill>
        </button>
      </div>
      {open && <SessionPanel mode="tracker" title="Ask about the tracker" placeholder="Which applications went cold? What should I follow up on this week?" />}
    </div>
  );
}

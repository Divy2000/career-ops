import { useState } from 'react';
import { SessionPanel } from '../../components/SessionPanel';
import { Pill } from '../../components/ui';
import { useRememberedSession } from '../../lib/useRememberedSession';
import type { TrackerRow } from '@shared/api';

const describeRows = (rows: TrackerRow[]) => rows.map((r) => `#${r.num} ${r.company}: ${r.role}${r.url ? ` (${r.url})` : ''}`).join('\n');

/**
 * Tracker multi-select: Compare runs the ofertas mode over the selected rows (spec 1c). The last comparison (this
 * browser tab) is shown again when the Tracker comes back, so a running one is not lost by leaving the page.
 */
export function CompareSelected({ rows, onClear }: { rows: TrackerRow[]; onClear: () => void }) {
  const compare = useRememberedSession('cc.tracker.compare');
  // The rows of a comparison started here; one re-attached after a return has its rows in its own transcript.
  const [launched, setLaunched] = useState<TrackerRow[] | null>(null);
  if (rows.length === 0 && !compare.shown) return null;
  const launch = () => {
    setLaunched(rows);
    compare.start();
  };
  return (
    <div className="stack">
      {rows.length > 0 && (
        <div className="toolbar selection-bar" role="region" aria-label="Selected rows">
          <span className="muted small">{rows.length} selected</span>
          <button type="button" disabled={rows.length < 2} onClick={launch} title={rows.length < 2 ? 'Select at least two rows' : undefined}>
            Compare selected (ofertas) <Pill tone="warn">Uses tokens</Pill>
          </button>
          <button type="button" className="button--ghost" onClick={onClear}>
            Clear selection
          </button>
        </div>
      )}
      {compare.shown && (
        <SessionPanel
          key={compare.panelKey}
          {...compare.panel}
          mode="ofertas"
          title={launched ? `Compare ${launched.length} applications` : 'Compare applications'}
          target={launched ? { type: 'text', value: launched.map((r) => r.num).join(',') } : undefined}
          initialPrompt={launched ? `Compare these tracked applications side by side and recommend where to focus:\n${describeRows(launched)}` : undefined}
        />
      )}
    </div>
  );
}

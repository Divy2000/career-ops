import { useState } from 'react';
import { SessionPanel } from '../../components/SessionPanel';
import { Pill } from '../../components/ui';
import type { TrackerRow } from '@shared/api';

/** Tracker multi-select: Compare runs the ofertas mode over the selected rows (spec 1c). */
export function CompareSelected({ rows, onClear }: { rows: TrackerRow[]; onClear: () => void }) {
  const [launched, setLaunched] = useState<{ key: number; rows: TrackerRow[] } | null>(null);
  if (rows.length === 0 && !launched) return null;
  const list = rows.map((r) => `#${r.num} ${r.company}: ${r.role}${r.url ? ` (${r.url})` : ''}`).join('\n');
  return (
    <div className="stack">
      {rows.length > 0 && (
        <div className="toolbar selection-bar" role="region" aria-label="Selected rows">
          <span className="muted small">{rows.length} selected</span>
          <button type="button" disabled={rows.length < 2} onClick={() => setLaunched({ key: Date.now(), rows })} title={rows.length < 2 ? 'Select at least two rows' : undefined}>
            Compare selected (ofertas) <Pill tone="warn">Uses tokens</Pill>
          </button>
          <button type="button" className="button--ghost" onClick={onClear}>
            Clear selection
          </button>
        </div>
      )}
      {launched && <SessionPanel key={launched.key} mode="ofertas" title={`Compare ${launched.rows.length} applications`} target={{ type: 'text', value: launched.rows.map((r) => r.num).join(',') }} initialPrompt={`Compare these tracked applications side by side and recommend where to focus:\n${launched.rows.map((r) => `#${r.num} ${r.company}: ${r.role}${r.url ? ` (${r.url})` : ''}`).join('\n')}`} />}
      {launched && rows.length === 0 && <span className="sr-only">{list}</span>}
    </div>
  );
}

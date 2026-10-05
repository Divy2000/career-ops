import { useState } from 'react';
import { SessionPanel } from './SessionPanel';
import type { Target } from '../lib/sessions';

export interface ModeChoice {
  id: string;
  label: string;
  prompt?: string;
}

/** A mode picker plus one session panel per launch, for host pages that own several modes (spec 1c). */
export function ModeLauncher({ modes, target, heading }: { modes: ModeChoice[]; target?: Target; heading: string }) {
  const [mode, setMode] = useState(modes[0]?.id ?? '');
  const [launched, setLaunched] = useState<Array<{ key: number; mode: ModeChoice }>>([]);
  const chosen = modes.find((m) => m.id === mode) ?? modes[0];
  return (
    <div className="stack">
      <div className="card">
        <h2>{heading}</h2>
        <div className="row gap">
          <label className="mode-launcher__pick">
            <span className="sr-only">Mode</span>
            <select aria-label={`${heading} mode`} value={mode} onChange={(e) => setMode(e.target.value)}>
              {modes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} ({m.id})
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={!chosen} onClick={() => chosen && setLaunched((prev) => [{ key: Date.now(), mode: chosen }, ...prev])}>
            Open prompt
          </button>
        </div>
      </div>
      {launched.map((l) => (
        <SessionPanel key={l.key} mode={l.mode.id} title={l.mode.label} target={target} initialPrompt={l.mode.prompt} />
      ))}
    </div>
  );
}

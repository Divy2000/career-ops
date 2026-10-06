import { useEffect, useMemo, useState } from 'react';
import { SessionPanel } from './SessionPanel';
import { rememberedLaunches } from '../lib/lastSession';
import type { Target } from '../lib/sessions';

export interface ModeChoice {
  id: string;
  label: string;
  prompt?: string;
}

interface Launched {
  key: string;
  mode: ModeChoice;
  sessionId: string | null;
}

/**
 * A mode picker plus one session panel per launch, for host pages that own several modes (spec 1c). With `rememberAs`,
 * the sessions it started are kept (this browser tab) and shown again when the launcher comes back, so a running or
 * waiting session is not lost by leaving the page.
 */
export function ModeLauncher({ modes, target, heading, rememberAs }: { modes: ModeChoice[]; target?: Target; heading: string; rememberAs?: string }) {
  const store = useMemo(() => (rememberAs ? rememberedLaunches(rememberAs) : null), [rememberAs]);
  const [mode, setMode] = useState(modes[0]?.id ?? '');
  const [launched, setLaunched] = useState<Launched[]>(() => (store?.read() ?? []).map((l) => ({ key: `s-${l.id}`, mode: modes.find((m) => m.id === l.mode) ?? { id: l.mode, label: l.mode }, sessionId: l.id })));
  useEffect(() => {
    store?.write(launched.flatMap((l) => (l.sessionId ? [{ mode: l.mode.id, id: l.sessionId }] : [])));
  }, [launched, store]);
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
          <button type="button" disabled={!chosen} onClick={() => chosen && setLaunched((prev) => [{ key: `n-${Date.now()}`, mode: chosen, sessionId: null }, ...prev])}>
            Open prompt
          </button>
        </div>
      </div>
      {launched.map((l) => (
        <SessionPanel
          key={l.key}
          mode={l.mode.id}
          title={l.mode.label}
          target={target}
          initialPrompt={l.mode.prompt}
          sessionId={l.sessionId}
          onSessionId={(id) => setLaunched((prev) => prev.map((x) => (x.key === l.key ? { ...x, sessionId: id } : x)))}
          // Deleted on the Sessions page (or a stale id): let it go rather than show it again.
          onStatus={(s) => s === 'gone' && setLaunched((prev) => prev.filter((x) => x.key !== l.key))}
        />
      ))}
    </div>
  );
}

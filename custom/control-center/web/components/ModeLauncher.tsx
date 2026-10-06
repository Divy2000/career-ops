import { useEffect, useMemo, useState } from 'react';
import { SessionPanel } from './SessionPanel';
import { rememberedLaunches, type Launch } from '../lib/lastSession';
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
  const fromStore = (l: Launch): Launched => ({ key: `s-${l.id}`, mode: modes.find((m) => m.id === l.mode) ?? { id: l.mode, label: l.mode }, sessionId: l.id });
  const [mode, setMode] = useState(modes[0]?.id ?? '');
  const [launched, setLaunched] = useState<Launched[]>(() => (store?.read() ?? []).map(fromStore));
  useEffect(() => {
    store?.write(launched.flatMap((l) => (l.sessionId ? [{ mode: l.mode.id, id: l.sessionId }] : [])));
  }, [launched, store]);
  // A start reported after its launcher unmounted lands in the store; show it here if this launcher does not have it yet.
  useEffect(
    () =>
      store?.subscribe(() =>
        setLaunched((prev) => {
          const late = store.read().filter((l) => !prev.some((x) => x.sessionId === l.id));
          return late.length ? [...late.map(fromStore), ...prev] : prev;
        }),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fromStore reads only `modes`, fixed per host page
    [store],
  );
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
          onSessionId={(id) => {
            setLaunched((prev) => prev.map((x) => (x.key === l.key ? { ...x, sessionId: id } : x)));
            // Recorded in the store too: the setState above is lost when the launcher unmounted before the start answered.
            store?.add({ mode: l.mode.id, id });
          }}
          // Deleted on the Sessions page (or a stale id): let it go rather than show it again.
          onStatus={(s) => s === 'gone' && setLaunched((prev) => prev.filter((x) => x.key !== l.key))}
        />
      ))}
    </div>
  );
}

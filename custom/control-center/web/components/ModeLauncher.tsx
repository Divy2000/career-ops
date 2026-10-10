import { useEffect, useMemo, useState } from 'react';
import { SessionPanel } from './SessionPanel';
import { lastSession, rememberedLaunches, type Launch } from '../lib/lastSession';
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

// A start sent by a launcher's panel is marked (per key) until it reports its session or its failure, so a launcher
// mounted meanwhile (the page was left and reopened before POST /api/sessions answered) waits instead of offering a
// second paid start. Every launcher mounted under the key hears the mark change.
const startListeners = new Map<string, Set<() => void>>();
function startChanged(key: string) {
  for (const fn of startListeners.get(key) ?? []) fn();
}
function onStartChange(key: string, fn: () => void) {
  const set = startListeners.get(key) ?? new Set();
  set.add(fn);
  startListeners.set(key, set);
  return () => {
    set.delete(fn);
    if (set.size === 0) startListeners.delete(key);
  };
}

/** The storage key of a launcher whose host names none: its heading, and its target, so one application's sessions stay on it. */
const defaultKey = (heading: string, target?: Target) => `cc.launcher:${heading}${target ? `:${target.type}:${target.value}` : ''}`;

/**
 * A mode picker plus one session panel per launch, for host pages that own several modes (spec 1c). The sessions it
 * started are kept (this browser tab) under `rememberAs`, or a key made of its heading and target, and shown again when
 * the launcher comes back, so a running or waiting session is not lost by leaving the page.
 */
export function ModeLauncher({ modes, target, heading, rememberAs }: { modes: ModeChoice[]; target?: Target; heading: string; rememberAs?: string }) {
  const storeKey = rememberAs ?? defaultKey(heading, target);
  const store = useMemo(() => rememberedLaunches(storeKey), [storeKey]);
  const marks = useMemo(() => lastSession(storeKey), [storeKey]);
  // Only launches of a mode this launcher offers: a stale or edited entry must not attach another mode's session here.
  const fromStore = (ls: Launch[]): Launched[] =>
    ls.flatMap((l) => {
      const m = modes.find((x) => x.id === l.mode);
      return m ? [{ key: `s-${l.id}`, mode: m, sessionId: l.id }] : [];
    });
  const [mode, setMode] = useState(modes[0]?.id ?? '');
  const [launched, setLaunched] = useState<Launched[]>(() => fromStore(store.read()));
  const [startingElsewhere, setStartingElsewhere] = useState(marks.starting);
  // Starts sent by this mount's own panels: the mark is theirs, so this launcher does not wait on itself.
  const [ownStarts, setOwnStarts] = useState(0);
  // A start reported after its launcher unmounted lands in the store; show it here if this launcher does not have it
  // yet. Read once on subscribing too, for a report that landed between the first render and this effect.
  useEffect(() => {
    const sync = () => {
      setStartingElsewhere(marks.starting());
      setLaunched((prev) => {
        const late = fromStore(store.read().filter((l) => !prev.some((x) => x.sessionId === l.id)));
        return late.length ? [...late, ...prev] : prev;
      });
    };
    sync();
    const offStore = store.subscribe(sync);
    const offStart = onStartChange(storeKey, sync);
    return () => {
      offStore();
      offStart();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fromStore reads only `modes`, fixed per host page
  }, [store, marks, storeKey]);
  const setMark = (on: boolean) => {
    marks.setStarting(on);
    startChanged(storeKey);
  };
  const waiting = startingElsewhere && ownStarts === 0;
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
          <button type="button" disabled={!chosen || waiting} onClick={() => chosen && setLaunched((prev) => [{ key: `n-${Date.now()}`, mode: chosen, sessionId: null }, ...prev])}>
            Open prompt
          </button>
        </div>
        {waiting && (
          <p role="status" className="muted small">
            Starting a session. It shows here once the server answers.
          </p>
        )}
      </div>
      {launched.map((l) => (
        <SessionPanel
          key={l.key}
          mode={l.mode.id}
          title={l.mode.label}
          target={target}
          initialPrompt={l.mode.prompt}
          sessionId={l.sessionId}
          onStarting={() => {
            setOwnStarts((n) => n + 1);
            setMark(true);
          }}
          onStartFailed={() => {
            setOwnStarts((n) => Math.max(0, n - 1));
            setMark(false);
          }}
          onSessionId={(id) => {
            // A start reports once; a fork reports again with the new session, which replaces the one it forked from.
            if (l.sessionId === null) {
              setOwnStarts((n) => Math.max(0, n - 1));
              marks.setStarting(false);
            }
            setLaunched((prev) => prev.map((x) => (x.key === l.key ? { ...x, sessionId: id } : x)));
            // Recorded in the store directly: the setState above is lost when the launcher unmounted before the start answered.
            if (l.sessionId) store.write(store.read().filter((x) => x.id !== l.sessionId));
            store.add({ mode: l.mode.id, id });
            startChanged(storeKey);
          }}
          // Deleted on the Sessions page (or a stale id): let it go rather than show it again.
          onStatus={(s) => {
            if (s !== 'gone') return;
            setLaunched((prev) => prev.filter((x) => x.key !== l.key));
            const gone = l.sessionId;
            if (gone) store.write(store.read().filter((x) => x.id !== gone));
          }}
        />
      ))}
    </div>
  );
}

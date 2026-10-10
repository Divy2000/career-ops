import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelSession } from '../../lib/sessions';

const ENDED = new Set(['done', 'error', 'cancelled', 'gone']);

/**
 * The paid parser session an import starts for an uploaded PDF. While it runs (from the upload until its envelope
 * lands or it ends) the import counts as unsaved, since leaving drops its result. Retiring it (a newer pick, or the
 * import going away) cancels it, so it stops spending tokens on a result nothing would receive.
 */
export function useParseSession() {
  const [parsing, setParsing] = useState(false);
  const running = useRef(false);
  const forPath = useRef<string | null>(null);
  const sessionId = useRef<string | null>(null);
  // Uploads retired before their start answered: their session is cancelled as soon as its id arrives.
  const retiredStarts = useRef(new Set<string>());
  const settle = useCallback(() => {
    running.current = false;
    setParsing(false);
  }, []);
  const retire = useCallback(() => {
    const id = sessionId.current;
    // A cancel that fails leaves a session that already ended or is going away: nothing more to stop.
    if (running.current && id) void cancelSession(id).catch(() => undefined);
    else if (running.current && forPath.current) retiredStarts.current.add(forPath.current);
    sessionId.current = null;
  }, []);
  useEffect(() => retire, [retire]);
  /** A new pick: retires the running parse, and starts tracking the one for `path` (null: no parse). */
  const begin = (path: string | null) => {
    retire();
    forPath.current = path;
    running.current = path !== null;
    setParsing(path !== null);
  };
  /** The parse's panel callbacks, bound to its upload so a retired panel's late report is ignored. */
  const panelFor = useCallback(
    (path: string) => ({
      onSessionId: (id: string) => {
        if (retiredStarts.current.delete(path)) void cancelSession(id).catch(() => undefined);
        else if (forPath.current === path) {
          // A fork answers with a new session: that is the one to cancel now.
          sessionId.current = id;
          running.current = true;
          setParsing(true);
        }
      },
      onStatus: (status: string) => {
        if (forPath.current !== path) return;
        // A parse waiting for the user's reply has not delivered its result yet either.
        if (ENDED.has(status)) settle();
        else if (status === 'queued' || status === 'running') {
          // Resumed by a reply after it ended: it is running for a result again.
          running.current = true;
          setParsing(true);
        }
      },
      onStartFailed: () => {
        retiredStarts.current.delete(path);
        if (forPath.current === path) settle();
      },
    }),
    [settle],
  );
  return { parsing, begin, done: settle, panelFor };
}

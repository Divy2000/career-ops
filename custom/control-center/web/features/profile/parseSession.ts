import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelSession } from '../../lib/sessions';

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
  const settle = useCallback(() => {
    running.current = false;
    setParsing(false);
  }, []);
  const retire = useCallback(() => {
    const id = sessionId.current;
    // A cancel that fails leaves a session that already ended or is going away: nothing more to stop.
    if (running.current && id) void cancelSession(id).catch(() => undefined);
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
        if (forPath.current === path) sessionId.current = id;
      },
      onStatus: (status: string) => {
        if (forPath.current === path && status !== 'queued' && status !== 'running') settle();
      },
      onStartFailed: () => {
        if (forPath.current === path) settle();
      },
    }),
    [settle],
  );
  return { parsing, begin, done: settle, panelFor };
}

import { useCallback, useMemo, useState } from 'react';
import { lastSession } from './lastSession';

/**
 * A page's paid session that must survive leaving the page: the last one started under `key` (this browser tab) is
 * re-attached when the page comes back, and `busy` stays true while it is queued or running, so a second one cannot
 * start beside it. Hand `panel` (and `panelKey` as its key) to the SessionPanel; `start` begins a new one.
 */
export function useRememberedSession(key: string) {
  const store = useMemo(() => lastSession(key), [key]);
  const [id, setId] = useState<string | null>(store.read);
  const [starts, setStarts] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [startFailed, setStartFailed] = useState(false);
  const shown = id !== null || starts > 0;
  const busy = shown && !startFailed && (status === null || status === 'queued' || status === 'running');
  const onStatus = useCallback(
    (s: string) => {
      setStatus(s);
      // Deleted on the Sessions page (or a stale id): let it go, and the button comes back.
      if (s === 'gone') {
        store.write(null);
        setId(null);
      }
    },
    [store],
  );
  const onSessionId = useCallback(
    (sid: string) => {
      store.write(sid);
      setId(sid);
    },
    [store],
  );
  // The panel shows why the start failed; the button comes back for another try.
  const onStartFailed = useCallback(() => setStartFailed(true), []);
  const start = () => {
    store.write(null);
    setId(null);
    setStatus(null);
    setStartFailed(false);
    setStarts((n) => n + 1);
  };
  // panelKey remounts the panel for each new start, so it does not keep the session it showed before.
  return { shown, busy, start, panelKey: starts, panel: { sessionId: id, autoStart: starts > 0 && id === null, onSessionId, onStatus, onStartFailed } };
}

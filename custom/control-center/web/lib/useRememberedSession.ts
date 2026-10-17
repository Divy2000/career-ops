import { useCallback, useEffect, useMemo, useState } from 'react';
import { lastSession, START_REPORT_WINDOW_MS, subscribeSession } from './lastSession';

/**
 * A page's paid session that must survive leaving the page: the last one started under `key` (this browser tab) is
 * re-attached when the page comes back, and `busy` stays true while it is starting, queued or running, so a second one
 * cannot start beside it. Hand `panel` (and `panelKey` as its key) to the SessionPanel; `start` begins a new one.
 * `holdWhileAwaiting` also keeps `busy` true while the session waits for the user's reply: for a session that must stay
 * the only one of its kind (it writes shared files), whose reply carries it on, so a second one must not start beside it.
 */
export function useRememberedSession(key: string, { holdWhileAwaiting = false }: { holdWhileAwaiting?: boolean } = {}) {
  const store = useMemo(() => lastSession(key), [key]);
  const [id, setId] = useState<string | null>(store.read);
  const [startingElsewhere, setStartingElsewhere] = useState(store.starting);
  const [starts, setStarts] = useState(0);
  // A start this mount sent (start() or its panel's own form) that has not reported yet, as opposed to one another mount sent.
  const [startingHere, setStartingHere] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [startFailed, setStartFailed] = useState(false);
  useEffect(() => {
    const sync = () => {
      setId(store.read());
      setStartingElsewhere(store.starting());
    };
    // A start that reported between the first render and this subscription is picked up here.
    sync();
    return subscribeSession(key, sync);
  }, [key, store]);
  // Another mount's start still in flight: no panel to show yet, but the button stays off until it reports, even while
  // an earlier finished session is still held here.
  const waiting = startingElsewhere && !startingHere;
  // A start marked by a page that reloaded mid-flight has no panel left to report it; if it never does within a bounded
  // window, clear the mark so the start form is not disabled forever.
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => store.setStarting(false), START_REPORT_WINDOW_MS);
    return () => clearTimeout(t);
  }, [waiting, key, store]);
  const shown = id !== null || starts > 0;
  // A reply or fork reported as a start (marksTurnStarts) runs a session the stream still shows as finished. The status
  // counts only while a session is held: a panel left without one (its session gone) reports an empty stream's 'queued'.
  const held = id !== null && !startFailed;
  const awaitingReply = held && status === 'awaiting_user';
  const busy = waiting || startingHere || (held && (status === null || status === 'queued' || status === 'running' || (holdWhileAwaiting && awaitingReply)));
  const onStatus = useCallback(
    (s: string) => {
      setStatus(s);
      // A session started from the panel after a failed start (its own Start, or a reply to one that came back errored) runs now.
      if (s === 'queued' || s === 'running') setStartFailed(false);
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
      store.setStarting(false);
      setStartingHere(false);
      // A new session (a start or a fork) has not reported yet: the one held before it may have ended, which must not
      // read as this one's end. A reply reports the same session, whose status the stream may already have shown.
      if (sid !== id) setStatus(null);
      setId(sid);
    },
    [store, id],
  );
  // The panel shows why the start failed; the button comes back for another try.
  const onStartFailed = useCallback(() => {
    store.setStarting(false);
    setStartingHere(false);
    setStartFailed(true);
  }, [store]);
  // The panel started a session from its own form: marked like start(), so a page mounted meanwhile waits for it.
  const onStarting = useCallback(() => {
    store.setStarting(true);
    setStartingHere(true);
    setStartFailed(false);
  }, [store]);
  const start = () => {
    store.write(null);
    store.setStarting(true);
    setStartingHere(true);
    setId(null);
    setStatus(null);
    setStartFailed(false);
    setStarts((n) => n + 1);
  };
  // panelKey remounts the panel for each new start, so it does not keep the session it showed before.
  return { shown, busy, waiting, awaitingReply, start, panelKey: starts, panel: { sessionId: id, autoStart: starts > 0 && id === null, onSessionId, onStatus, onStartFailed, onStarting } };
}

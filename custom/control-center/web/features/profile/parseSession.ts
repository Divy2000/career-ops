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
  // Bumped by every pick. Panel callbacks are bound to the pick they were made for, not to its upload path: a re-pick of
  // the same file gets the same path back (the upload keeps one copy of identical bytes), and the retired pick's late
  // reports must not act on the new parse.
  const pick = useRef(0);
  const sessionId = useRef<string | null>(null);
  // Picks retired before their start answered: their session is cancelled as soon as its id arrives.
  const retiredStarts = useRef(new Set<number>());
  // Whether the current parse has settled (its result landed, or it ended): only a new turn after that re-arms it, not
  // the panel re-sending the status it already reported.
  const settled = useRef(false);
  // A start, reply or fork the panel sent whose session id has not come back yet. Retiring the pick meanwhile cancels
  // that session once its id arrives, and the import counts as unsaved until then.
  const startPending = useRef(false);
  // Whether that start is a reply or fork to a parse still under way: its failure leaves the parse running.
  const pendingOnLive = useRef(false);
  const [starting, setStarting] = useState(false);
  const setPending = (on: boolean) => {
    startPending.current = on;
    setStarting(on);
  };
  // One set of panel callbacks per upload, so a re-render hands the panel the same ones.
  const callbacks = useRef(new Map<string, { onStarting: () => void; onSessionId: (id: string) => void; onStatus: (status: string) => void; onStartFailed: () => void; marksTurnStarts: true }>());
  const settle = useCallback(() => {
    running.current = false;
    settled.current = true;
    setParsing(false);
  }, []);
  const arm = () => {
    running.current = true;
    settled.current = false;
    setParsing(true);
  };
  const retire = useCallback(() => {
    const id = sessionId.current;
    // A cancel that fails leaves a session that already ended or is going away: nothing more to stop.
    if (running.current && id) void cancelSession(id).catch(() => undefined);
    // A start not answered yet (the first one, or a restart, reply or fork the panel sent) is cancelled once its id arrives.
    if (startPending.current || (running.current && !id)) retiredStarts.current.add(pick.current);
    sessionId.current = null;
    startPending.current = false;
  }, []);
  useEffect(() => retire, [retire]);
  /** A new pick: retires the running parse, and starts tracking the one for `path` (null: no parse). */
  const begin = (path: string | null) => {
    retire();
    pick.current += 1;
    running.current = path !== null;
    settled.current = false;
    callbacks.current.clear();
    setParsing(path !== null);
    setStarting(false);
  };
  /** The parse's panel callbacks, bound to the current pick so a retired panel's late report is ignored. */
  const panelFor = (path: string) => {
    const known = callbacks.current.get(path);
    if (known) return known;
    const mine = pick.current;
    // The last status the panel reported, so a repeat of it is told apart from a new turn.
    let last: string | null = null;
    // The last session id the panel reported: a new one after its pick was retired is a fork nothing will receive.
    let reported: string | null = null;
    const made = {
      onStarting: () => {
        if (pick.current !== mine) return;
        pendingOnLive.current = running.current && sessionId.current !== null;
        setPending(true);
      },
      onSessionId: (id: string) => {
        const fresh = id !== reported;
        reported = id;
        if (pick.current === mine) setPending(false);
        if (retiredStarts.current.delete(mine) || (pick.current !== mine && fresh)) void cancelSession(id).catch(() => undefined);
        else if (pick.current === mine && id !== sessionId.current) {
          // The first id, or a fork's new session: that is the one to cancel now. A fork runs for a result again.
          // A retry after a failed start (settled with no id yet) runs for a result too.
          const fork = sessionId.current !== null;
          sessionId.current = id;
          if (fork || settled.current) arm();
        }
      },
      onStatus: (status: string) => {
        if (pick.current !== mine) return;
        const previous = last;
        last = status;
        // A parse waiting for the user's reply has not delivered its result yet either.
        if (ENDED.has(status)) settle();
        // Resumed by a reply after it ended: it is running for a result again. A repeated status, or a reply after the
        // result landed and the session asked a follow-up, is not a parse for a new result.
        else if ((status === 'queued' || status === 'running') && settled.current && previous !== null && ENDED.has(previous)) arm();
      },
      onStartFailed: () => {
        retiredStarts.current.delete(mine);
        if (pick.current !== mine) return;
        setPending(false);
        if (!pendingOnLive.current) settle();
      },
      // A reply or fork is reported as a start too, so one in flight is cancelled like a first start.
      marksTurnStarts: true as const,
    };
    callbacks.current.set(path, made);
    return made;
  };
  return { parsing: parsing || starting, begin, done: settle, panelFor };
}

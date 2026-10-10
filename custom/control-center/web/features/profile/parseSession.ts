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
  // Whether the current parse has settled (its result landed, or it ended): only a new turn after that re-arms it, not
  // the panel re-sending the status it already reported.
  const settled = useRef(false);
  // One set of panel callbacks per upload, so a re-render hands the panel the same ones.
  const callbacks = useRef(new Map<string, { onSessionId: (id: string) => void; onStatus: (status: string) => void; onStartFailed: () => void }>());
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
    else if (running.current && forPath.current) retiredStarts.current.add(forPath.current);
    sessionId.current = null;
  }, []);
  useEffect(() => retire, [retire]);
  /** A new pick: retires the running parse, and starts tracking the one for `path` (null: no parse). */
  const begin = (path: string | null) => {
    retire();
    forPath.current = path;
    running.current = path !== null;
    settled.current = false;
    callbacks.current.clear();
    setParsing(path !== null);
  };
  /** The parse's panel callbacks, bound to its upload so a retired panel's late report is ignored. */
  const panelFor = (path: string) => {
    const known = callbacks.current.get(path);
    if (known) return known;
    // The last status the panel reported, so a repeat of it is told apart from a new turn.
    let last: string | null = null;
    const made = {
      onSessionId: (id: string) => {
        if (retiredStarts.current.delete(path)) void cancelSession(id).catch(() => undefined);
        else if (forPath.current === path && id !== sessionId.current) {
          // The first id, or a fork's new session: that is the one to cancel now. A fork runs for a result again.
          const fork = sessionId.current !== null;
          sessionId.current = id;
          if (fork) arm();
        }
      },
      onStatus: (status: string) => {
        if (forPath.current !== path) return;
        const previous = last;
        last = status;
        // A parse waiting for the user's reply has not delivered its result yet either.
        if (ENDED.has(status)) settle();
        // Resumed by a reply after it ended: it is running for a result again. A repeated status, or a reply after the
        // result landed and the session asked a follow-up, is not a parse for a new result.
        else if ((status === 'queued' || status === 'running') && settled.current && previous !== null && ENDED.has(previous)) arm();
      },
      onStartFailed: () => {
        retiredStarts.current.delete(path);
        if (forPath.current === path) settle();
      },
    };
    callbacks.current.set(path, made);
    return made;
  };
  return { parsing, begin, done: settle, panelFor };
}

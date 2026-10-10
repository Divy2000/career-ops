import { useQueryClient } from '@tanstack/react-query';
import { localJdPath } from '@shared/local-jd';
import type { SessionMeta } from '@shared/api';
import { startEvaluateSession, startSavedJdSession, useSessions } from '../../lib/sessions';

/** Where a posting reference opens: the posting URL, or the saved JD a `local:jds/<file>` reference points at. */
export const postingHref = (ref: string) => {
  const jd = localJdPath(ref);
  return jd === null ? ref : `/api/files/serve?path=${encodeURIComponent(jd)}`;
};

const ACTIVE = new Set(['queued', 'running', 'awaiting_user']);

/**
 * The evaluation of a posting reference that is still queued, running or waiting on the user, if any. Neither the
 * sessions route nor the manager dedupes oferta sessions by target, so a page offers this session instead of a second
 * paid one.
 */
export function useActiveEvaluation() {
  const sessions = useSessions();
  return (ref: string): SessionMeta | undefined => sessions.data?.find((s) => s.mode === 'oferta' && ACTIVE.has(s.status) && s.target.value === ref);
}

// Starts still waiting on POST /api/sessions, by posting reference: a second Evaluate of the same posting meanwhile
// (its shortlist row and Quick evaluate) joins the first instead of sending another.
const starting = new Map<string, Promise<SessionMeta>>();

/**
 * Starts the oferta session for a posting reference: a saved JD as its file (no URL to check or fetch), anything else
 * as a posting URL. The new session goes into the sessions list at once, so coming back before the next poll already
 * shows it as running.
 */
export function useStartEvaluation() {
  const qc = useQueryClient();
  return (ref: string): Promise<SessionMeta> => {
    const pending = starting.get(ref);
    if (pending) return pending;
    const jd = localJdPath(ref);
    const start = (jd === null ? startEvaluateSession(ref) : startSavedJdSession(ref, jd))
      .then((m) => {
        qc.setQueryData<SessionMeta[]>(['sessions'], (prev) => [m, ...(prev ?? []).filter((s) => s.id !== m.id)]);
        return m;
      })
      .finally(() => starting.delete(ref));
    starting.set(ref, start);
    return start;
  };
}

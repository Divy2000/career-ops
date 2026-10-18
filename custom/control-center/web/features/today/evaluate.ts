import { useQueryClient } from '@tanstack/react-query';
import { localJdPath } from '@shared/local-jd';
import { dedupUrlKey } from '@shared/dedup-url';
import type { SessionMeta } from '@shared/api';
import { startEvaluateSession, startSavedJdSession, useSessions } from '../../lib/sessions';
import { isReportGatedMode } from '../pipeline/evaluating';

const ACTIVE = new Set(['queued', 'running', 'awaiting_user']);

/** GET /api/sessions marks a session whose status ended while its process is still stopping. */
type ListedSession = SessionMeta & { stopping?: true };

/**
 * The evaluation of a posting reference that is still queued, running or waiting on the user, if any, in any
 * report-gated mode (oferta, auto-pipeline, a localized oferta). A cancelled one still stopping counts too: the server
 * refuses a new evaluation of its posting until it exits. A page offers this session instead of a start that fails.
 */
export function useActiveEvaluation() {
  const sessions = useSessions();
  return (ref: string): SessionMeta | undefined => activeEvaluationIn(sessions.data ?? [], ref);
}

/** The active evaluation of a posting reference in a given sessions list (a fresh read, say, rather than the poll). */
export function activeEvaluationIn(sessions: readonly ListedSession[], ref: string): SessionMeta | undefined {
  const key = postingRefKey(ref);
  return sessions.find((s) => isReportGatedMode(s.mode) && (ACTIVE.has(s.status) || s.stopping === true) && s.target.value !== null && postingRefKey(s.target.value) === key);
}

/** A posting URL by the key POST /api/pipeline/add dedups it on (two spellings of one posting are one); a saved JD as is. */
const postingRefKey = (ref: string) => (localJdPath(ref) === null ? dedupUrlKey(ref) : ref);

// Starts still waiting on POST /api/sessions, by posting reference (its dedup key): a second Evaluate of the same
// posting meanwhile (its shortlist row and Quick evaluate, or another spelling of its URL) joins the first instead of
// sending another.
const starting = new Map<string, Promise<SessionMeta>>();

/** Whether an Evaluate start for a posting reference is still waiting on POST /api/sessions (it is in no list yet). */
export const evaluationStarting = (ref: string): boolean => starting.has(postingRefKey(ref));

/**
 * Starts the oferta session for a posting reference: a saved JD as its file (no URL to check or fetch), anything else
 * as a posting URL. The new session goes into the sessions list at once, so coming back before the next poll already
 * shows it as running.
 */
export function useStartEvaluation() {
  const qc = useQueryClient();
  return (ref: string): Promise<SessionMeta> => {
    const key = postingRefKey(ref);
    const pending = starting.get(key);
    if (pending) return pending;
    const jd = localJdPath(ref);
    const start = (jd === null ? startEvaluateSession(ref) : startSavedJdSession(ref, jd))
      .then(async (m) => {
        // A list fetch asked before the start would answer without it: drop that answer, keep the new session.
        await qc.cancelQueries({ queryKey: ['sessions'], exact: true });
        qc.setQueryData<SessionMeta[]>(['sessions'], (prev) => [m, ...(prev ?? []).filter((s) => s.id !== m.id)]);
        return m;
      })
      .finally(() => starting.delete(key));
    starting.set(key, start);
    return start;
  };
}

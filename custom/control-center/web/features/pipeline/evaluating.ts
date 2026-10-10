import type { SessionMeta } from '@shared/api';

// A session waiting for the user's reply still owns its row: answering it finishes the evaluation.
const LIVE = new Set(['queued', 'running', 'awaiting_user']);

/**
 * The posting URLs and saved-JD references an oferta session is evaluating right now. The server starts a second
 * evaluation of the same target without asking, and a row stays pending until its evaluation is done, so pages leave
 * these out of a new start.
 */
export function evaluatingTargets(sessions: SessionMeta[] | undefined): Set<string> {
  return new Set((sessions ?? []).filter((s) => s.mode === 'oferta' && LIVE.has(s.status) && s.target.value).map((s) => s.target.value!));
}

import type { SessionMeta } from '@shared/api';

/**
 * What a fan-out answer means for the user. The fan-out answers 202 even when a session failed before its turn ran
 * (no approved CLI, no token): that session carries status error and its report number went back to the pool.
 */
export function fanoutOutcome({ sessions, reserved }: { sessions: SessionMeta[]; reserved: number[] }): { failedUrls: string[]; text: string } {
  const ok = sessions.filter((s) => s.status !== 'error');
  const failed = sessions.filter((s) => s.status === 'error');
  // The fan-out hands the i-th reserved number to the i-th session.
  const numbers = reserved.filter((_, i) => sessions[i]?.status !== 'error');
  const reports = `report number${numbers.length === 1 ? '' : 's'} ${numbers.join(', ')}`;
  const why = [...new Set(failed.map((s) => s.error ?? 'the session failed to start'))].join('; ');
  const failedUrls = failed.map((s) => s.target.value).filter((u): u is string => !!u);
  if (failed.length === 0) return { failedUrls, text: `Started ${ok.length} evaluations with ${reports}.` };
  if (ok.length === 0) return { failedUrls, text: `Could not start the evaluations: ${why}` };
  return { failedUrls, text: `Started ${ok.length} of ${sessions.length} evaluations with ${reports}. ${failed.length} could not start: ${why}` };
}

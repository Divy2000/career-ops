/**
 * Some insight scripts report "nothing to analyze yet" as `{ error: "..." }` with exit 0 (analyze-patterns, upskill).
 * That is an empty state, not a failure; returns the script's own explanation, or null for a real result.
 */
export function emptyReason(json: unknown): string | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const error = (json as { error?: unknown }).error;
  return typeof error === 'string' && error.trim() !== '' ? error : null;
}

/**
 * For a run that exited non-zero: analyze-patterns exits 1 on its "Not enough data: N/5" answer (it exits 0 only for
 * noData errors). Only an error that marks itself as missing data (noData, or the current/threshold counts) is empty.
 */
export function failedEmptyReason(json: unknown): string | null {
  const reason = emptyReason(json);
  if (reason === null) return null;
  const o = json as { noData?: unknown; current?: unknown; threshold?: unknown };
  return o.noData === true || (typeof o.current === 'number' && typeof o.threshold === 'number') ? reason : null;
}

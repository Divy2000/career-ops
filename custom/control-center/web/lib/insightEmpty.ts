/**
 * Some insight scripts report "nothing to analyze yet" as `{ error: "..." }` with exit 0 (analyze-patterns, upskill).
 * That is an empty state, not a failure; returns the script's own explanation, or null for a real result.
 */
export function emptyReason(json: unknown): string | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const error = (json as { error?: unknown }).error;
  return typeof error === 'string' && error.trim() !== '' ? error : null;
}

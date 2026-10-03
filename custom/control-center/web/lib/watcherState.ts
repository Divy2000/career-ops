export interface WatcherSummary {
  lastRun: string | null;
  sources: Array<{ name: string; lastSuccess: string }>;
  /** Present only for the older single-date last_success. */
  lastSuccess?: string;
  seenCount: number;
  pendingCount: number | null;
}

/** Condenses data/immigration/seen.json for display; the raw file stays behind a disclosure. */
export function summarizeWatcher(seen: unknown, pendingCount: number | null): WatcherSummary | { error: string } | null {
  if (seen === null || seen === undefined) return null;
  if (typeof seen !== 'object') return { error: 'seen.json is not an object' };
  const o = seen as Record<string, unknown>;
  if (typeof o.error === 'string') return { error: o.error };
  const out: WatcherSummary = {
    lastRun: typeof o.last_run === 'string' ? o.last_run : null,
    sources: [],
    seenCount: Array.isArray(o.ids) ? o.ids.length : 0,
    pendingCount,
  };
  if (typeof o.last_success === 'string') out.lastSuccess = o.last_success;
  else if (o.last_success && typeof o.last_success === 'object') {
    out.sources = Object.entries(o.last_success as Record<string, unknown>)
      .filter((e): e is [string, string] => typeof e[1] === 'string')
      .map(([name, lastSuccess]) => ({ name, lastSuccess }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}

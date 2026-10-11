// The key POST /api/pipeline/add dedups a posting URL by: a port of scan.mjs normalizeUrlForDedup (with url-key.mjs
// promoteKnownFragmentIdentity), which the browser cannot import. tests/unit/dedup-url.test.ts holds the two together.

// Query params that carry no identity for a posting (scan.mjs DEDUP_STRIP_PARAMS); compared lowercased.
const DEDUP_STRIP_PARAMS = new Set(['language', 'lang', 'locale', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'src', 'source', 'gh_src', 'lever-origin', 'lever-source', 'rltr']);

/** A `#/job/{id}` or `#/jobs/{id}` SPA route names the posting: its id joins the query before the fragment is dropped. */
function promoteKnownFragmentIdentity(url: URL): void {
  const match = /^#\/jobs?\/([^/?#]+)(?:\?[^#]*)?$/i.exec(url.hash);
  if (!match) return;
  let jobId: string;
  try {
    jobId = decodeURIComponent(match[1]!);
  } catch {
    return;
  }
  if (!jobId) return;
  url.searchParams.append(url.hostname.toLowerCase() === 'app.mokahr.com' ? 'mokahr_job_id' : '_career_ops_fragment_job_id', jobId);
}

/** The dedup key of a posting URL; an unparsable string is its own key. */
export function dedupUrlKey(url: string): string {
  if (!url) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  for (const param of Array.from(parsed.searchParams.keys())) {
    if (DEDUP_STRIP_PARAMS.has(param.toLowerCase())) parsed.searchParams.delete(param);
  }
  promoteKnownFragmentIdentity(parsed);
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '').toLowerCase() || '/';
  return parsed.toString();
}

// The posting URL rule POST /api/pipeline/add checks every URL by. The server applies it to offer envelopes and to
// writes; the AI search tab applies it before sending, since one URL the route refuses fails the whole body.

const MAX_URL_LEN = 2048;

/** Accept only a real http(s) posting URL (trimmed); anything else cannot become a write. */
export function postingUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > MAX_URL_LEN || /[\0\r\n]/.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || u.username || u.password) return null;
  return s;
}

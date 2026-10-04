// One validation rule for a company name typed into the Sponsorship lookup, used by the form and by the server routes.
export const MAX_COMPANY_QUERY_LENGTH = 200;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export type ParsedQuery = { ok: true; value: string } | { ok: false; error: string };

export function parseCompanyQuery(raw: unknown): ParsedQuery {
  if (typeof raw !== 'string') return { ok: false, error: 'a company name is required' };
  const value = raw.trim();
  if (!value) return { ok: false, error: 'a company name is required' };
  if (value.length > MAX_COMPANY_QUERY_LENGTH) return { ok: false, error: `the company name is longer than ${MAX_COMPANY_QUERY_LENGTH} characters` };
  if (CONTROL_CHARS.test(value)) return { ok: false, error: 'the company name contains control characters' };
  // check.mjs reads a dash-led argument as a flag (and drops it), so such a name could also smuggle in --cache-dir.
  if (value.startsWith('-')) return { ok: false, error: 'the company name must not start with a dash' };
  return { ok: true, value };
}

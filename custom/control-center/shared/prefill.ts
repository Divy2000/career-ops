// The hosts prepare-application.mjs accepts (its ALLOWED_HOSTS), so the Apply form and the server can say why a link
// will not prefill before the script runs. tests/unit/prefill.test.ts fails when the upstream list drifts from this one.
export const PREFILL_ATS_HOSTS = ['boards.greenhouse.io', 'greenhouse.io', 'jobs.ashbyhq.com', 'ashbyhq.com', 'jobs.lever.co', 'jobs.eu.lever.co', 'lever.co'] as const;

/** Why this posting URL cannot be prefilled, or null when the script accepts its host. */
export function prefillUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Enter the full apply link, starting with https://.';
  }
  if (url.protocol !== 'https:') return 'Zero-token prefill needs an https:// apply link.';
  if (!(PREFILL_ATS_HOSTS as readonly string[]).includes(url.hostname)) {
    return `Zero-token prefill reads Greenhouse, Ashby and Lever apply links only, and ${url.hostname} is not one. Open the posting, follow its Apply button to the employer's application page and paste that link here.`;
  }
  return null;
}

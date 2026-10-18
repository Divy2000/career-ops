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
  // The link goes to prepare-application.mjs as a command-line argument (readable in ps) and into its log.
  if (url.username || url.password) return 'This link carries a user name or password. Remove the part before the @ and paste the plain posting link.';
  const secret = secretParam(url);
  if (secret !== null) return `This link carries a ${secret} parameter, which looks like a secret. Remove it and paste the plain posting link.`;
  if (!(PREFILL_ATS_HOSTS as readonly string[]).includes(url.hostname)) {
    return `Zero-token prefill reads Greenhouse, Ashby and Lever apply links only, and ${url.hostname} is not one. Open the posting, follow its Apply button to the employer's application page and paste that link here.`;
  }
  const ats = ATS_SHAPES.find((a) => a.hosts.includes(url.hostname))!;
  return ats.accepts(url.pathname) ? null : `This ${ats.name} link does not point at one job. Use the posting link shaped like ${ats.example}.`;
}

// Query or fragment parameter names that carry credentials (token, access_token, api_key, X-Amz-Signature, sessionid...),
// never the tracking ones boards add (gh_src, gh_jid, lever-source). The script reads only the host and path.
const SECRET_PARAM = /token|secret|passw|pwd|api[_-]?key|access[_-]?key|auth|signature|credential|session|^(key|sig|code)$/i;

function secretParam(url: URL): string | null {
  const fragment = url.hash.slice(1);
  for (const params of [url.searchParams, ...(fragment.includes('=') ? [new URLSearchParams(fragment)] : [])]) {
    for (const name of params.keys()) if (SECRET_PARAM.test(name)) return name;
  }
  return null;
}

// The path shapes detectAts() in prepare-application.mjs accepts; tests/unit/prefill.test.ts runs the script against both.
const SAFE_SLUG = /^[a-zA-Z0-9._-]+$/;
const ATS_SHAPES: { name: string; hosts: string[]; example: string; accepts: (pathname: string) => boolean }[] = [
  {
    name: 'Greenhouse',
    hosts: ['boards.greenhouse.io', 'greenhouse.io'],
    example: 'boards.greenhouse.io/<company>/jobs/<number>',
    accepts: (p) => {
      const m = p.match(/^\/([^/]+)\/jobs\/(\d+)/);
      return Boolean(m && SAFE_SLUG.test(m[1]!));
    },
  },
  ...(
    [
      ['Ashby', ['jobs.ashbyhq.com', 'ashbyhq.com'], 'jobs.ashbyhq.com/<company>/<posting id>'],
      ['Lever', ['jobs.lever.co', 'jobs.eu.lever.co', 'lever.co'], 'jobs.lever.co/<company>/<posting id>'],
    ] as const
  ).map(([name, hosts, example]) => ({
    name,
    hosts: [...hosts],
    example,
    accepts: (p: string) => {
      const m = p.match(/^\/([^/]+)\/([^/?#]+)/);
      return Boolean(m && SAFE_SLUG.test(m[1]!) && SAFE_SLUG.test(m[2]!));
    },
  })),
];

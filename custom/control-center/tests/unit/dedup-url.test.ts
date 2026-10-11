// The browser's "already known" check must key a posting URL exactly as POST /api/pipeline/add does, which is
// scan.mjs normalizeUrlForDedup. The shared port is checked against the real function on every shape it handles.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { dedupUrlKey } from '../../shared/dedup-url.js';

const CASES = [
  'https://boards.greenhouse.io/acme/jobs/123',
  'https://boards.greenhouse.io/acme/jobs/123?gh_src=abc1',
  'https://boards.greenhouse.io/acme/jobs/123?gh_jid=42&utm_source=x&UTM_Medium=y',
  'https://Boards.Greenhouse.IO/Acme/Jobs/123/',
  'HTTP://jobs.lever.co/globex/abc///?lever-origin=applied&lever-source=li#apply',
  'https://jobs.example.com/x?ref=a&src=b&source=c&rltr=d&language=en&lang=de&locale=fr&keep=Yes',
  'https://jobs.example.com/careers#/job/12345',
  'https://jobs.example.com/careers#/jobs/a%20b?x=1',
  'https://app.mokahr.com/social-recruitment/acme#/job/abc-123',
  'https://jobs.example.com/careers#/job/%E0%A4%A',
  'https://jobs.example.com/careers#section',
  'https://jobs.example.com/',
  'https://jobs.example.com',
  'https://jobs.example.com/a?b=1&b=2&utm_term=z',
  'not a url',
  '',
];

describe('dedupUrlKey', () => {
  it('matches scan.mjs normalizeUrlForDedup on every case', async () => {
    const { normalizeUrlForDedup } = (await import(pathToFileURL(path.join(DEFAULT_CODE_ROOT, 'scan.mjs')).href)) as { normalizeUrlForDedup: (u: string) => string };
    for (const url of CASES) expect(dedupUrlKey(url), url).toBe(normalizeUrlForDedup(url));
  });

  it('keys a tracking-parameter and fragment variant like the posting it repeats', () => {
    expect(dedupUrlKey('https://boards.greenhouse.io/acme/jobs/123?gh_src=abc1#apply')).toBe(dedupUrlKey('https://boards.greenhouse.io/acme/jobs/123'));
  });
});

// An offer envelope carries a posting URL the pipeline can take: POST /api/pipeline/add refuses anything but an
// http(s) URL with a host and no credentials, so the server refuses such an offer when it parses it (R16-feata-02).
import { describe, expect, it } from 'vitest';
import { extractEnvelopes } from '../../server/claude/envelopes.js';
import { postingUrl } from '../../shared/posting-url.js';
import { postingUrl as routePostingUrl } from '../../server/domains/inboxSkip.js';

const offer = (url: string) => `<<cc:offer ${JSON.stringify({ url, company: 'Acme', title: 'Engineer' })}>>`;

describe('offer envelopes', () => {
  it('accepts an http(s) posting URL', () => {
    for (const url of ['https://boards.greenhouse.io/acme/jobs/1', 'http://jobs.example.com/1']) {
      const [env] = extractEnvelopes(offer(url), false).envelopes;
      expect(env, url).toMatchObject({ ok: true, kind: 'offer', payload: { url } });
    }
  });

  it('refuses a URL the pipeline would refuse: another scheme, credentials, or one over 2048 characters', () => {
    for (const url of ['javascript:alert(1)', 'ftp://jobs.example.com/1', 'https://user:pw@jobs.example.com/1', `https://jobs.example.com/${'a'.repeat(2048)}`]) {
      const [env] = extractEnvelopes(offer(url), false).envelopes;
      expect(env!.ok, url).toBe(false);
    }
  });
});

describe('the shared posting URL rule', () => {
  it('is the rule the pipeline routes check by', () => {
    expect(routePostingUrl).toBe(postingUrl);
  });

  it('keeps an http(s) URL with a host, trimmed, and refuses anything else', () => {
    expect(postingUrl('  https://jobs.example.com/1  ')).toBe('https://jobs.example.com/1');
    for (const raw of [42, null, '', 'not a url', 'mailto:a@b.c', 'https://jobs.example.com/1\nx', 'https://a:b@jobs.example.com/']) expect(postingUrl(raw), String(raw)).toBeNull();
  });
});

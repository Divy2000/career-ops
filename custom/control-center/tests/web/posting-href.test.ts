// Today, the tracker and an application's page link a posting reference with postingHref (R35-feat-c-X-01). The URL
// comes from files other writers fill (data/shortlist.md, scan history, the tracker), so only an http(s) URL or a saved
// JD may become a link: a javascript: or data: URL in href would run in the Control Center's origin when clicked.
import { describe, expect, it } from 'vitest';
import { postingHref } from '@web/lib/posting-href';

describe('postingHref', () => {
  for (const url of ['https://jobs.example.com/1', 'http://jobs.example.com/1?gh_jid=2']) {
    it(`given the posting URL ${url}, then it links to it`, () => {
      expect(postingHref(url)).toBe(url);
    });
  }

  // A display link only needs a safe scheme: the write routes' 2048-character and no-credentials limits do not apply
  // to opening a posting a hand-edited file already holds (R35 fix-check FC-02).
  for (const url of [`https://jobs.example.com/1?utm=${'x'.repeat(3000)}`, 'https://user:pw@jobs.example.com/1', ' https://jobs.example.com/1 ']) {
    it(`given the http(s) URL ${url.slice(0, 40)}, then it still links to it`, () => {
      expect(postingHref(url)).toBe(url.trim());
    });
  }

  it('given a saved JD reference, then it links to the file through the serve route', () => {
    expect(postingHref('local:jds/acme.md')).toBe(`/api/files/serve?path=${encodeURIComponent('jds/acme.md')}`);
  });

  for (const ref of ['javascript:alert(document.domain)', ' JavaScript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd', '//evil.example/x', 'jobs.example.com/1', 'https://jobs.example.com/1\nx', '']) {
    it(`given ${JSON.stringify(ref)}, then there is no link`, () => {
      expect(postingHref(ref)).toBeUndefined();
    });
  }
});

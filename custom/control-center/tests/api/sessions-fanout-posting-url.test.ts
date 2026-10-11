// The fan-out takes only URLs the pipeline write routes would take (shared/posting-url.ts): an http(s) posting with no
// credentials. A URL carrying user:pass@ would land, credentials included, in a paid session's prompt, and another
// scheme starts an evaluation the liveness and fetch path cannot read (R21-feat-b-L3-01).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFixtureRoot, makeTestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

describe('POST /api/sessions/fanout posting URL rule', () => {
  for (const [label, bad] of [
    ['a URL with credentials', 'https://user:token@jobs.example.com/synthetic/123'],
    ['a URL with only a username', 'https://user@jobs.example.com/synthetic/124'],
    ['a non-http(s) URL', 'ftp://jobs.example.com/synthetic/125'],
  ] as const) {
    it(`given ${label} beside a good one, refuses the whole body before any number is reserved or session started`, async () => {
      const app = await makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
      try {
        const reports = path.join(app.cfg.dataRoot, 'reports');
        const before = fs.readdirSync(reports);
        const res = await app.app.inject({ method: 'POST', url: '/api/sessions/fanout', headers: app.authedWrite, payload: { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/126', bad] } });
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json().error).toBe('invalid body');
        expect(app.sessions.store.list()).toHaveLength(0);
        expect(fs.readdirSync(reports)).toEqual(before);
      } finally {
        await app.close();
      }
    });
  }
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURE_ROOT, makeTestApp, type TestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

let t: TestApp;
beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => {
  await t.close();
});

const get = (url: string) => t.app.inject({ method: 'GET', url, headers: t.authed });
// A header whose value could not be read (no ETag while the file cannot be read) is left out.
const send = (method: 'PUT' | 'POST', url: string, payload: Record<string, unknown>, headers: Record<string, string | undefined> = {}) =>
  t.app.inject({ method, url, headers: { ...t.authedWrite, ...Object.fromEntries(Object.entries(headers).filter(([, v]) => typeof v === 'string')) as Record<string, string> }, payload });

const PIPELINE_SEED = '# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/acme/123 | Acme Robotics | Senior Backend Engineer\n';
const FOLLOWUPS_SEED = '# Follow-ups\n\n| num | appNum | date | company | role | channel | contact | notes |\n|---|---|---|---|---|---|---|---|\n| 1 | 1 | 2026-09-28 | Acme Robotics | Senior Backend Engineer | Email | Pat Example | first nudge |\n';

/** Every writer that saves a user file through writeFileAtomic, with the file it writes and a request that makes it write. */
const WRITERS: Array<{ name: string; rel: string; seed: string; write: () => Promise<{ statusCode: number; body: string }> }> = [
  {
    name: 'PUT /api/files/user/cv',
    rel: 'cv.md',
    seed: '# CV\n',
    write: async () => send('PUT', '/api/files/user/cv', { text: '# New CV\n' }, { 'if-match': (await get('/api/files/user/cv')).json().etag }),
  },
  {
    name: 'PUT /api/files/user/profileMd',
    rel: 'modes/_profile.md',
    seed: '# Profile\n',
    write: async () => send('PUT', '/api/files/user/profileMd', { text: '# New profile\n' }, { 'if-match': (await get('/api/files/user/profileMd')).json().etag }),
  },
  {
    name: 'PUT /api/config/portals',
    rel: 'portals.yml',
    seed: fs.readFileSync(path.join(FIXTURE_ROOT, 'portals.yml'), 'utf8'),
    write: async () => {
      const before = (await get('/api/config/portals')).json();
      return send('PUT', '/api/config/portals', { raw: `# edited\n${before.raw}` }, { 'if-match': before.etag });
    },
  },
  {
    name: 'PUT /api/config/plugins/:id',
    rel: 'config/plugins.yml',
    seed: 'plugins: {}\n',
    write: async () => {
      const etag = ((await get('/api/plugins')).json().config?.etag) as string | undefined;
      return send('PUT', '/api/config/plugins/gmail', { enabled: true }, { 'if-match': etag });
    },
  },
  {
    name: 'PUT /api/blacklist',
    rel: 'data/blacklist.md',
    seed: '# Blacklist\n\n| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Spam Staffing Ltd | 2026-09-01 | company | spam |\n',
    write: async () =>
      send('PUT', '/api/blacklist', { confirm: true, rows: [{ company: 'Spam Staffing Ltd', since: '2026-09-01', scope: 'company', reason: 'spam' }, { company: 'Acme Recruiting', since: '2026-10-01', scope: 'company', reason: 'spam' }] }, { 'if-match': (await get('/api/blacklist')).json().etag, 'x-cc-explicit': 'blacklist' }),
  },
  {
    name: 'POST /api/memory',
    rel: 'modes/_profile.md',
    seed: '# Profile\n',
    write: async () => send('POST', '/api/memory', { fact: 'Prefers remote roles' }),
  },
  {
    name: 'POST /api/pipeline/skip',
    rel: 'data/pipeline.md',
    seed: '# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/acme/123 | Acme Robotics | Senior Backend Engineer\n',
    write: async () => send('POST', '/api/pipeline/skip', { url: 'https://jobs.example.com/acme/123', done: true }),
  },
  // SW-tests-06: the pipeline adds write through scan.mjs, the follow-up edits through a child of their own.
  {
    name: 'POST /api/pipeline/add (pipeline.md)',
    rel: 'data/pipeline.md',
    seed: PIPELINE_SEED,
    write: async () => send('POST', '/api/pipeline/add', { offers: [{ url: 'https://jobs.example.com/new/1', company: 'New Co', title: 'Platform Engineer' }] }),
  },
  {
    name: 'POST /api/pipeline/add (scan-history.tsv)',
    rel: 'data/scan-history.tsv',
    seed: 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n',
    write: async () => send('POST', '/api/pipeline/add', { offers: [{ url: 'https://jobs.example.com/new/2', company: 'New Co', title: 'Platform Engineer' }] }),
  },
  {
    name: 'POST /api/pipeline/urls',
    rel: 'data/pipeline.md',
    seed: PIPELINE_SEED,
    write: async () => send('POST', '/api/pipeline/urls', { urls: ['https://jobs.example.com/new/3'] }),
  },
  {
    name: 'POST /api/followups/log',
    rel: 'data/follow-ups.md',
    seed: FOLLOWUPS_SEED,
    write: async () => send('POST', '/api/followups/log', { appNum: 1, date: '2026-10-04', channel: 'Email', contact: 'Pat', notes: 'nudged' }),
  },
  {
    name: 'POST /api/followups/override',
    rel: 'data/follow-ups.md',
    seed: FOLLOWUPS_SEED,
    write: async () => send('POST', '/api/followups/override', { appNum: 1, date: '2026-10-20' }),
  },
];

/** Replaces `rel` in the data root with a symlink to a file holding `seed` at `target`. */
function linkTo(rel: string, target: string, seed: string): string {
  const link = path.join(t.cfg.dataRoot, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, seed);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.rmSync(link, { force: true });
  fs.symlinkSync(target, link);
  return link;
}

describe('a user file that is a symlink', () => {
  for (const w of WRITERS) {
    it(`${w.name}: refuses to write through a link that leads outside the data root, and leaves the link and its target alone`, async () => {
      const outside = path.join(tempDir('cc-link-outside-'), 'shared.md');
      const link = linkTo(w.rel, outside, w.seed);
      const res = await w.write();
      expect(res.statusCode, res.body).toBe(403);
      expect((JSON.parse(res.body) as { error: string }).error).toMatch(/outside the data root; nothing was written/);
      expect(fs.readFileSync(outside, 'utf8')).toBe(w.seed);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(link)).toBe(outside);
    });

    it(`${w.name}: writes through a link whose target is inside the data root, and the link stays a link`, async () => {
      const inside = path.join(t.cfg.dataRoot, 'synced', path.basename(w.rel));
      const link = linkTo(w.rel, inside, w.seed);
      const res = await w.write();
      expect(res.statusCode, res.body).toBeLessThan(300);
      expect(fs.readFileSync(inside, 'utf8')).not.toBe(w.seed);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    });
  }

  for (const w of WRITERS) {
    it(`${w.name}: answers a link loop with a 403 that says why, never a 500, and leaves the link alone`, async () => {
      const link = path.join(t.cfg.dataRoot, w.rel);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.rmSync(link, { force: true });
      fs.symlinkSync(path.basename(w.rel), link);
      const looped = await w.write();
      expect(looped.statusCode, looped.body).toBe(403);
      expect((JSON.parse(looped.body) as { error: string }).error).toMatch(new RegExp(`cannot tell where ${w.rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} leads \\(ELOOP.*nothing was read or written`));
      expect(fs.readlinkSync(link)).toBe(path.basename(w.rel));
    });
  }
});

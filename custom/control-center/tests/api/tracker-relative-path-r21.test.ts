import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readInsight } from '../../server/domains/insightsCache.js';
import type { Exec } from '../../server/routes/system.js';
import { FIXTURE_ROOT, makeTestApp, testConfig, type TestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

/**
 * A relative CAREER_OPS_TRACKER names a file relative to the code root, the cwd the tracker scripts run in (AGENTS.md
 * "Tracker path"). The server's own cwd (custom/control-center under npm start, and under vitest) is a different folder,
 * so a reader resolving against it reads a file the scripts never write.
 */
describe('a relative CAREER_OPS_TRACKER is read from the code root, not the server cwd (FU-trkrel-01)', () => {
  let before: string | undefined;
  let t: TestApp | null = null;
  let folder: string;
  beforeEach(() => {
    before = process.env.CAREER_OPS_TRACKER;
    folder = tempDir('cc-tracker-relative-');
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'data', 'applications.md'), path.join(folder, 'applications.md'));
    fs.writeFileSync(path.join(folder, 'status-log.tsv'), '1\t2026-10-02\tApplied\tInterview\tset-status\trelative lane\n');
    const cfg = testConfig();
    expect(path.resolve(cfg.codeRoot)).not.toBe(process.cwd());
    process.env.CAREER_OPS_TRACKER = path.relative(cfg.codeRoot, path.join(folder, 'applications.md'));
  });
  afterEach(async () => {
    await t?.close();
    t = null;
    if (before === undefined) delete process.env.CAREER_OPS_TRACKER;
    else process.env.CAREER_OPS_TRACKER = before;
  });

  it('GET /api/tracker serves the rows of the tracker the scripts write', async () => {
    t = await makeTestApp();
    const body = (await t.app.inject({ method: 'GET', url: '/api/tracker', headers: t.authed })).json();
    expect(body.kind).toBe('ok');
    expect(body.rows).toHaveLength(6);
    expect(fs.realpathSync(body.path)).toBe(fs.realpathSync(path.join(folder, 'applications.md')));
  });

  it('GET /api/tracker/:n reads the status log beside that tracker', async () => {
    t = await makeTestApp();
    const body = (await t.app.inject({ method: 'GET', url: '/api/tracker/1', headers: t.authed })).json();
    expect(body.timeline.statusLog).toEqual([expect.objectContaining({ num: 1, date: '2026-10-02', to: 'Interview' })]);
  });

  it('the insights cache recomputes when that tracker or its status log changes', async () => {
    let runs = 0;
    const exec: Exec = async () => ((runs += 1), { code: 0, stdout: '{"ok":true}', stderr: '' });
    const cfg = testConfig();
    await readInsight(cfg, exec, 'funnelVelocity');
    expect((await readInsight(cfg, exec, 'funnelVelocity')).fromCache).toBe(true);
    for (const file of [path.join(folder, 'status-log.tsv'), path.join(folder, 'applications.md')]) {
      const later = new Date(Date.now() + 60_000 * (runs + 1));
      fs.utimesSync(file, later, later);
      const ran = runs;
      await readInsight(cfg, exec, 'funnelVelocity');
      expect(runs, `${file} changed`).toBe(ran + 1);
    }
  });
});

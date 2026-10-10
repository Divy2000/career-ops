import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { inputsKey, readInsight } from '../../server/domains/insightsCache.js';
import { copyFixtureRoot, FIXTURE_ROOT, testConfig } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';
import { execNoShell, type Exec } from '../../server/routes/system.js';
import { findAction } from '../../server/actions/registry.js';

describe('the insights cache key', () => {
  // upskill leaves out skills cv.md already has and story provenance traces stories to cv.md and the digest.
  for (const rel of ['cv.md', 'article-digest.md']) {
    it(`changes when ${rel} is edited, so cached insights are recomputed`, () => {
      const root = copyFixtureRoot();
      const file = path.join(root, rel);
      const before = inputsKey(root);
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(file, later, later);
      expect(inputsKey(root)).not.toBe(before);
    });
  }
});

describe('the insights cache key covers every file the insights scripts read', () => {
  // assessment-log.mjs, salary-gap.mjs:39, process-quality.mjs:45 and rejection-latency.mjs:64 (data/ first, then the
  // root copy), funnel-velocity.mjs:251, detect-reposts.mjs:76.
  for (const rel of ['data/assessments.tsv', 'data/salary-observations.tsv', 'data/active-interviews.md', 'active-interviews.md', 'config/benchmarks.yml', 'portals.yml']) {
    it(`changes when ${rel} is added or edited`, () => {
      const root = copyFixtureRoot();
      const file = path.join(root, rel);
      fs.rmSync(file, { force: true });
      const before = inputsKey(root);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'x\n');
      const added = inputsKey(root);
      expect(added).not.toBe(before);
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(file, later, later);
      expect(inputsKey(root)).not.toBe(added);
    });
  }

  for (const rel of ['reports/001-acme-robotics.md', 'interview-prep/story-bank.md']) {
    it(`changes when ${rel} is edited in place (its folder's own time does not move)`, () => {
      const root = copyFixtureRoot();
      const dir = path.dirname(path.join(root, rel));
      const dirTime = fs.statSync(dir).mtime;
      const before = inputsKey(root);
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(path.join(root, rel), later, later);
      fs.utimesSync(dir, dirTime, dirTime);
      expect(inputsKey(root)).not.toBe(before);
    });
  }
});

describe('the insights cache key on a root-layout tracker (R7-14)', () => {
  // set-status.mjs logs beside the tracker, so a tracker at the top keeps status-log.tsv at the top too.
  for (const rel of ['applications.md', 'status-log.tsv']) {
    it(`changes when the top-level ${rel} is added or edited`, () => {
      const root = copyFixtureRoot();
      const before = inputsKey(root);
      fs.writeFileSync(path.join(root, rel), 'x\n');
      expect(inputsKey(root)).not.toBe(before);
    });
  }
});

describe('the insights cache with CAREER_OPS_TRACKER outside the data root (R7-14 review)', () => {
  it('recomputes when that tracker or the status-log.tsv beside it changes', async () => {
    const outside = tempDir('cc-outside-tracker-');
    const tracker = path.join(outside, 'applications.md');
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'data', 'applications.md'), tracker);
    fs.writeFileSync(path.join(outside, 'status-log.tsv'), '2\t2026-10-01\tEvaluated\tApplied\tweb\t\n');
    const before = process.env.CAREER_OPS_TRACKER;
    process.env.CAREER_OPS_TRACKER = tracker;
    let runs = 0;
    const exec: Exec = async () => ((runs += 1), { code: 0, stdout: '{"ok":true}', stderr: '' });
    try {
      const cfg = testConfig();
      await readInsight(cfg, exec, 'funnelVelocity');
      await readInsight(cfg, exec, 'funnelVelocity');
      expect(runs).toBe(1);
      for (const file of [path.join(outside, 'status-log.tsv'), tracker]) {
        const later = new Date(Date.now() + 60_000 * (runs + 1));
        fs.utimesSync(file, later, later);
        const ran = runs;
        await readInsight(cfg, exec, 'funnelVelocity');
        expect(runs, `${file} changed`).toBe(ran + 1);
      }
      expect(runs).toBe(3);
    } finally {
      if (before === undefined) delete process.env.CAREER_OPS_TRACKER;
      else process.env.CAREER_OPS_TRACKER = before;
    }
  });
});

describe('the insights cache across days (R8-09)', () => {
  // rejection-latency.mjs, weekly-digest.mjs, funnel-velocity.mjs and company-history.mjs all count from today, so a
  // result computed yesterday is stale even when no input file changed.
  it('serves the cached result for the rest of the local day and recomputes on the next one', async () => {
    let runs = 0;
    const exec: Exec = async () => ((runs += 1), { code: 0, stdout: '{"ok":true}', stderr: '' });
    const cfg = testConfig();
    // Local time in America/Los_Angeles (vitest pins TZ): 08:00 and 23:30 on 2026-10-05, then 00:30 on 2026-10-06.
    const morning = Date.parse('2026-10-05T15:00:00.000Z');
    const night = Date.parse('2026-10-06T06:30:00.000Z');
    const nextDay = Date.parse('2026-10-06T07:30:00.000Z');
    await readInsight(cfg, exec, 'rejectionLatency', { now: () => morning });
    expect((await readInsight(cfg, exec, 'rejectionLatency', { now: () => night })).fromCache).toBe(true);
    expect(runs).toBe(1);
    const next = await readInsight(cfg, exec, 'rejectionLatency', { now: () => nextDay });
    expect(next.fromCache).toBe(false);
    expect(runs).toBe(2);
  });

  it('does not cache a failed run, so the next load retries it instead of serving the failure all day (R12-srv-dom-a-L1-02)', async () => {
    let runs = 0;
    let code = 1;
    const exec: Exec = async () => ((runs += 1), { code, stdout: code === 0 ? '{"ok":true}' : '', stderr: '' });
    const cfg = testConfig();
    expect((await readInsight(cfg, exec, 'funnelVelocity')).kind).toBe('failed');
    code = 0;
    const retry = await readInsight(cfg, exec, 'funnelVelocity');
    expect(retry).toMatchObject({ kind: 'ok', fromCache: false });
    expect(runs).toBe(2);
    expect((await readInsight(cfg, exec, 'funnelVelocity')).fromCache).toBe(true);
  });
});

describe('Company history reads the data root, wherever it is (SW7-server-01)', () => {
  it('the insight builds its cards from the data root\'s tracker, follow-ups and scan history, not the code checkout\'s', async () => {
    const root = copyFixtureRoot();
    const cfg = testConfig({ dataRoot: root });
    const read = await readInsight(cfg, execNoShell, 'companyHistory', { recompute: true });
    expect(read.kind, read.text).toBe('ok');
    const json = read.json as { metadata: { sources: Record<string, boolean> }; companies: Array<{ company: string }> };
    expect(json.metadata.sources).toMatchObject({ tracker: true, followups: true, scanHistory: true });
    expect(json.companies.map((c) => c.company)).toContain('Acme Robotics');
  });

  it('a tracker or portals file named in the environment wins, and the cache is keyed on the tracker the child reads (SW7-server-01 review)', async () => {
    const root = copyFixtureRoot();
    const elsewhere = path.join(tempDir('cc-tracker-elsewhere-'), 'applications.md');
    fs.copyFileSync(path.join(root, 'data', 'applications.md'), elsewhere);
    const portals = path.join(tempDir('cc-portals-elsewhere-'), 'portals.yml');
    fs.copyFileSync(path.join(root, 'portals.yml'), portals);
    const prior = { tracker: process.env.CAREER_OPS_TRACKER, portals: process.env.CAREER_OPS_PORTALS };
    process.env.CAREER_OPS_TRACKER = elsewhere;
    process.env.CAREER_OPS_PORTALS = portals;
    try {
      const seen: Array<Record<string, string | undefined>> = [];
      const capture: Exec = async (cmd, args, opts) => {
        seen.push({ ...(opts.env as Record<string, string | undefined>) });
        return execNoShell(cmd, args, opts);
      };
      const read = await readInsight(testConfig({ dataRoot: root }), capture, 'companyHistory', { recompute: true });
      expect(read.kind, read.text).toBe('ok');
      expect(seen[0]!.CAREER_OPS_TRACKER ?? process.env.CAREER_OPS_TRACKER).toBe(elsewhere);
      expect(seen[0]!.CAREER_OPS_PORTALS ?? process.env.CAREER_OPS_PORTALS).toBe(portals);
      expect(read.inputsKey.startsWith(`${inputsKey(root, fs.realpathSync(elsewhere))}|`)).toBe(true);
      const cmd = findAction('insights.companyHistory')!.build({}, { codeRoot: '/code', dataRoot: root, tmpInputs: [], trackerPath: elsewhere });
      expect(cmd.env?.CAREER_OPS_TRACKER ?? process.env.CAREER_OPS_TRACKER).toBe(elsewhere);
      expect(cmd.env?.CAREER_OPS_PORTALS ?? process.env.CAREER_OPS_PORTALS).toBe(portals);
    } finally {
      for (const [k, v] of [['CAREER_OPS_TRACKER', prior.tracker], ['CAREER_OPS_PORTALS', prior.portals]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('the Company history action is told the same files', () => {
    const root = copyFixtureRoot();
    const cmd = findAction('insights.companyHistory')!.build({}, { codeRoot: '/code', dataRoot: root, tmpInputs: [], trackerPath: path.join(root, 'data', 'applications.md') });
    expect(cmd.args).toEqual(expect.arrayContaining(['--followups', path.join(root, 'data', 'follow-ups.md'), '--scan-history', path.join(root, 'data', 'scan-history.tsv')]));
    expect(cmd.env).toMatchObject({ CAREER_OPS_TRACKER: path.join(root, 'data', 'applications.md'), CAREER_OPS_PORTALS: path.join(root, 'portals.yml') });
  });
});

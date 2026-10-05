import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseDigest, parseDailyLog, parseCompanyFile, readImmigrationOverview, listLogDates, daysBetween, withJobState, localDate } from '../../server/domains/immigration.js';
import { collectWhatsNew, resolveOfferLimit, evaluatedKeys, isEvaluated } from '../../server/domains/whatsNew.js';
import { computeDashboard, parseStatusLog, readStatusLog, workModeOf } from '../../server/domains/insights.js';
import { readTracker } from '../../server/domains/tracker.js';
import { readScanHistory } from '../../server/domains/pipeline.js';
import { importCore } from '../../server/core/adapter.js';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { copyFixtureRoot } from '../helpers/app.js';

const root = copyFixtureRoot();

describe('immigration overview', () => {
  it('splits the digest into dated sections and computes staleness', () => {
    const sections = parseDigest(fs.readFileSync(path.join(root, 'data/immigration/policy-digest.md'), 'utf8'));
    expect(sections.map((s) => s.date)).toEqual(['2026-10-02', '2026-09-30']);
    expect(sections[0]!.body).toContain('Proposed rule');
    expect(daysBetween('2026-10-01', '2026-10-03')).toBe(2);
  });

  it('parses daily logs by their markers', () => {
    const log = parseDailyLog(fs.readFileSync(path.join(root, 'data/immigration/logs/2026-10-03.log'), 'utf8'), '2026-10-03');
    expect(log.status).toBe('failed');
    expect(log.failedSteps).toEqual(['rank top 100']);
    expect(log.steps.map((s) => s.name)).toEqual(['policy watch', 'portal scan', 'prioritize pipeline', 'rank top 100', 'sponsorship shortlist']);
    expect(log.steps[3]!.failed).toBe(true);
    expect(parseDailyLog('=== 2026-10-03 08:00:00 start\n--- 08:00:01 policy watch\n', '2026-10-03').status).toBe('running');
    expect(parseDailyLog('', '2026-10-03').status).toBe('empty');
    expect(listLogDates(root)).toEqual(['2026-10-03']);
  });

  it('a dated log holds every run of that day: a clean re-run after a failed one reads ok, with its own times and steps', () => {
    const text = [
      '=== 2026-10-05 08:00:00 start',
      '--- 08:00:01 policy watch',
      '--- 08:04:03 rank top 100',
      '!!! step failed: rank top 100',
      '=== 2026-10-05 08:09:01 done (failed=1)',
      '=== 2026-10-05 10:15:00 start',
      '--- 10:15:01 policy watch',
      '--- 10:18:00 rank top 100',
      '=== 2026-10-05 10:24:30 done (failed=0)',
      '',
    ].join('\n');
    const log = parseDailyLog(text, '2026-10-05');
    expect(log).toMatchObject({ status: 'ok', failedSteps: [], failedCount: 0, startedAt: '2026-10-05 10:15:00', finishedAt: '2026-10-05 10:24:30' });
    expect(log.steps).toEqual([
      { name: 'policy watch', time: '10:15:01', failed: false },
      { name: 'rank top 100', time: '10:18:00', failed: false },
    ]);
  });

  it('a re-run in progress reads running from its own start, not with the earlier run\'s done time', () => {
    const text = '=== 2026-10-05 08:00:00 start\n--- 08:00:01 policy watch\n=== 2026-10-05 08:09:01 done (failed=0)\n=== 2026-10-05 10:15:00 start\n--- 10:15:01 policy watch\n';
    expect(parseDailyLog(text, '2026-10-05')).toMatchObject({ status: 'running', startedAt: '2026-10-05 10:15:00', finishedAt: null, failedCount: null, failedSteps: [] });
  });

  it('a run with no done line reads interrupted once the job is known not to run, and stays running while it runs or nobody knows', async () => {
    const log = parseDailyLog('=== 2026-10-05 08:00:00 start\nERROR: Keychain item missing\n', '2026-10-05');
    expect((await withJobState(log, '2026-10-05', async () => false)).status).toBe('interrupted');
    expect((await withJobState(log, '2026-10-05', async () => true)).status).toBe('running');
    expect((await withJobState(log, '2026-10-05', async () => null)).status).toBe('running');
  });

  it('a run with no done line in a log older than yesterday is interrupted, whatever the job is doing, and the probe is not asked', async () => {
    let asked = 0;
    const running = async () => {
      asked++;
      return true;
    };
    const log = parseDailyLog('=== 2026-10-03 08:00:00 start\n--- 08:00:01 policy watch\n', '2026-10-03');
    expect((await withJobState(log, '2026-10-05', running)).status).toBe('interrupted');
    expect((await withJobState(log, '2026-10-05', async () => null)).status).toBe('interrupted');
    expect(asked).toBe(0);
  });

  it('yesterday\'s run with no done line (one that crossed midnight) reads running only while the job is known to run', async () => {
    const log = parseDailyLog('=== 2026-10-04 23:58:00 start\n--- 23:58:01 policy watch\n', '2026-10-04');
    expect((await withJobState(log, '2026-10-05', async () => true)).status).toBe('running');
    expect((await withJobState(log, '2026-10-05', async () => false)).status).toBe('interrupted');
    // No probe (the weekly sync): an unfinished run from yesterday is not assumed to run on.
    expect((await withJobState(log, '2026-10-05', async () => null)).status).toBe('interrupted');
    const monthEnd = parseDailyLog('=== 2026-09-30 23:58:00 start\n', '2026-09-30');
    expect((await withJobState(monthEnd, '2026-10-01', async () => true)).status).toBe('running');
    const yearEnd = parseDailyLog('=== 2025-12-31 23:58:00 start\n', '2025-12-31');
    expect((await withJobState(yearEnd, '2026-01-01', async () => true)).status).toBe('running');
  });

  it('today is the local calendar date, not the UTC one', () => {
    expect(localDate(new Date(2026, 9, 5, 0, 5))).toBe('2026-10-05');
    expect(localDate(new Date(2026, 9, 5, 23, 55))).toBe('2026-10-05');
    expect(localDate(new Date(2026, 0, 9, 12, 0))).toBe('2026-01-09');
  });

  it('asks whether the job runs only for a run with no done line', async () => {
    let asked = 0;
    const probe = async () => {
      asked++;
      return false;
    };
    const done = parseDailyLog('=== 2026-10-05 08:00:00 start\n=== 2026-10-05 08:09:01 done (failed=0)\n', '2026-10-05');
    expect(await withJobState(done, '2026-10-05', probe)).toEqual(done);
    expect(await withJobState(parseDailyLog('', '2026-10-05'), '2026-10-05', probe)).toMatchObject({ status: 'empty' });
    expect(asked).toBe(0);
  });

  it('reads the weekly sync\'s done lines, which carry no failed count, as a finished run', () => {
    expect(parseDailyLog('=== 2026-10-04 03:00:00 start\n--- merging upstream/main\n=== 2026-10-04 03:20:00 done\n', '2026-10-04')).toMatchObject({ status: 'ok', finishedAt: '2026-10-04 03:20:00', failedCount: null });
    expect(parseDailyLog('=== 2026-10-04 03:00:00 start\n=== 2026-10-04 03:00:09 done (up to date)\n', '2026-10-04')).toMatchObject({ status: 'ok', finishedAt: '2026-10-04 03:00:09', failedCount: null });
  });

  it('any !!! line in the last run fails it with that line as the reason, even with no done line (sync.sh and run-daily.sh exit early that way)', async () => {
    const sync = parseDailyLog('=== 2026-10-04 03:00:00 start\n--- fetching\n!!! Keychain item career-ops-claude-token not found\n', '2026-10-04');
    expect(sync).toMatchObject({ status: 'failed', finishedAt: null, failedSteps: [], problems: ['Keychain item career-ops-claude-token not found'] });
    expect((await withJobState(sync, '2026-10-04', async () => false)).status).toBe('failed');
    const daily = parseDailyLog("=== 2026-10-05 08:00:00 start\n!!! Keychain item 'career-ops-claude-token' not found. Run: claude setup-token\n", '2026-10-05');
    expect(daily).toMatchObject({ status: 'failed', problems: ["Keychain item 'career-ops-claude-token' not found. Run: claude setup-token"] });
  });

  it('a step failure stays a failed step, not a problem, and an earlier run\'s !!! line does not fail the last run', () => {
    const text = '=== 2026-10-05 08:00:00 start\n!!! gh pr create failed\n=== 2026-10-05 10:00:00 start\n--- 10:00:01 rank top 100\n!!! step failed: rank top 100\n=== 2026-10-05 10:05:00 done (failed=1)\n';
    expect(parseDailyLog(text, '2026-10-05')).toMatchObject({ status: 'failed', failedSteps: ['rank top 100'], problems: [] });
    expect(parseDailyLog('=== 2026-10-05 08:00:00 start\n!!! gh pr create failed\n=== 2026-10-05 10:00:00 start\n=== 2026-10-05 10:05:00 done\n', '2026-10-05')).toMatchObject({ status: 'ok', problems: [] });
  });

  it('counts digest staleness from the local date by default, so an evening read (UTC already tomorrow) is not a day stale', async () => {
    // vitest runs in America/Los_Angeles: 20:00 local on 2026-10-04 is 03:00 UTC on 2026-10-05.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 9, 4, 20, 0));
      expect((await readImmigrationOverview(DEFAULT_CODE_ROOT, root)).digest).toMatchObject({ latestDate: '2026-10-02', staleDays: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('parses company files and the whole overview through the core lib', async () => {
    const cf = parseCompanyFile('# Acme\n\nchecked_at: 2026-09-28\nverdict: strong\ndol_tier: strong\npolicy_changes_seen: 2\n', 'acme', '/x', (md) => md.match(/checked_at:\s*(\S+)/)?.[1] ?? null);
    expect(cf).toMatchObject({ name: 'Acme', checkedAt: '2026-09-28', verdict: 'strong', dolTier: 'strong', policyChangesSeen: 2 });
    const o = await readImmigrationOverview(DEFAULT_CODE_ROOT, root, '2026-10-04');
    expect(o.digest).toMatchObject({ kind: 'ok', latestDate: '2026-10-02', staleDays: 2 });
    expect(o.policyChanges).toHaveLength(2);
    expect(o.alerts.history).toHaveLength(2);
    expect(o.alerts.latest.map((a) => a.slug).sort()).toEqual(['globex-payments', 'initech-cloud']);
    expect(o.companies.map((c) => c.slug)).toEqual(['acme-robotics', 'globex-payments']);
    expect(o.officialFeed).toHaveLength(2);
    expect(o.dailyLog?.status).toBe('failed');
    expect((o.tiers as { companies: Record<string, unknown> }).companies['acme robotics']).toBeDefined();
  });

  it('counts the watcher queue from pending.json and reports null when there is none', async () => {
    expect((await readImmigrationOverview(DEFAULT_CODE_ROOT, root, '2026-10-04')).pendingCount).toBeNull();
    const withQueue = copyFixtureRoot();
    fs.writeFileSync(path.join(withQueue, 'data/immigration/pending.json'), JSON.stringify([{ id: 'a' }, { id: 'b' }]));
    expect((await readImmigrationOverview(DEFAULT_CODE_ROOT, withQueue, '2026-10-04')).pendingCount).toBe(2);
    expect((await readImmigrationOverview(DEFAULT_CODE_ROOT, withQueue, '2026-10-04')).pendingError).toBeNull();
    expect((await readImmigrationOverview(DEFAULT_CODE_ROOT, root, '2026-10-04')).pendingError).toBeNull();
  });

  it('reports a corrupt or non-list pending.json as an error, distinct from an absent one', async () => {
    const bad = copyFixtureRoot();
    fs.writeFileSync(path.join(bad, 'data/immigration/pending.json'), '{not json');
    expect(await readImmigrationOverview(DEFAULT_CODE_ROOT, bad, '2026-10-04')).toMatchObject({ pendingCount: null, pendingError: 'pending.json is not valid JSON' });
    fs.writeFileSync(path.join(bad, 'data/immigration/pending.json'), '{"a":1}');
    expect(await readImmigrationOverview(DEFAULT_CODE_ROOT, bad, '2026-10-04')).toMatchObject({ pendingCount: null, pendingError: 'pending.json is not a list of items' });
  });

  it('reports a missing digest distinctly', async () => {
    const empty = copyFixtureRoot();
    fs.rmSync(path.join(empty, 'data/immigration'), { recursive: true });
    const o = await readImmigrationOverview(DEFAULT_CODE_ROOT, empty);
    expect(o.digest).toEqual({ kind: 'missing' });
    expect(o.companies).toEqual([]);
    expect(o.dailyLog).toBeNull();
  });
});

describe('fresh matches (whats-new port)', () => {
  it('keys suppression on company and role using the core normalizer', async () => {
    const { normalizeTextKey } = await importCore<{ normalizeTextKey: (v: unknown, sep?: string) => string }>(DEFAULT_CODE_ROOT, 'tracker-parse.mjs');
    const keys = evaluatedKeys([{ company: 'Acme Robotics', role: 'Senior Backend Engineer' }, { company: '', role: 'x' }], normalizeTextKey);
    expect(keys.size).toBe(1);
    expect(isEvaluated(keys, normalizeTextKey, 'ACME Robotics', 'Senior Backend Engineer')).toBe(true);
    expect(isEvaluated(keys, normalizeTextKey, 'Acme Robotics', 'Staff Engineer')).toBe(false);
    expect(isEvaluated(keys, normalizeTextKey, '', 'x')).toBe(false);
  });

  it('returns recent, unevaluated, non-skipped rows newest first with a complete count', async () => {
    const { normalizeTextKey } = await importCore<{ normalizeTextKey: (v: unknown, sep?: string) => string }>(DEFAULT_CODE_ROOT, 'tracker-parse.mjs');
    const tracker = await readTracker(DEFAULT_CODE_ROOT, root);
    const apps = tracker.kind === 'ok' ? tracker.rows : [];
    const now = Date.parse('2026-10-03T12:00:00Z');
    const r = collectWhatsNew({ history: readScanHistory(root), applications: apps, norm: normalizeTextKey, now, days: 7, limit: 1 });
    // Northwind is suppressed (tracker row 2 has the same company and role), Hooli is skipped, the bad URL is dropped.
    expect(r.count).toBe(2);
    expect(r.offers).toHaveLength(1);
    expect(r.offers[0]).toMatchObject({ company: 'Pied Piper', ats: 'ashby', firstSeen: '2026-10-03', postedAt: '' });
    const all = collectWhatsNew({ history: readScanHistory(root), applications: apps, norm: normalizeTextKey, now, days: 7, limit: 50 });
    expect(all.offers.map((o) => o.company)).toEqual(['Pied Piper', 'Soylent Foods']);
    expect(resolveOfferLimit('5')).toBe(5);
    expect(resolveOfferLimit('nope')).toBe(12);
    expect(resolveOfferLimit('9999')).toBe(200);
  });
});

describe('insights dashboard', () => {
  it('parses the status ledger and tolerates blank lines', () => {
    expect(parseStatusLog('1\t2026-09-20\t-\tEvaluated\tset-status\t\n\nbad\n')).toEqual([{ num: 1, date: '2026-09-20', from: '-', to: 'Evaluated', source: 'set-status', note: '' }]);
    expect(readStatusLog(root)).toHaveLength(10);
  });

  it('computes totals, funnel, rates, buckets and breakdowns from fixtures', async () => {
    const t = await readTracker(DEFAULT_CODE_ROOT, root);
    if (t.kind !== 'ok') throw new Error('fixture tracker unreadable');
    const d = computeDashboard(t.rows, readStatusLog(root));
    expect(d.totals).toMatchObject({ applications: 6, scored: 5, averageScore: 3.9 });
    expect(d.totals.byStatus).toMatchObject({ Applied: 1, Interview: 1, SKIP: 1, Rejected: 1 });
    expect(d.funnel).toEqual([
      { stage: 'Evaluated', count: 5 },
      { stage: 'Applied', count: 3 },
      { stage: 'Responded', count: 2 },
      { stage: 'Interview', count: 1 },
      { stage: 'Offer', count: 0 },
      { stage: 'Hired', count: 0 },
    ]);
    expect(d.rates).toEqual({ evaluatedToApplied: 60, appliedToInterview: 33.3, interviewToOffer: 0 });
    expect(d.scoreBuckets.map((b) => b.count)).toEqual([1, 1, 2, 1]);
    expect(d.workMode).toEqual({ remote: 2, hybrid: 1, onsite: 2, unknown: 1 });
    expect(d.archetypes[0]).toMatchObject({ archetype: 'Backend Platform Engineer', count: 4 });
    expect(d.topCompanies).toHaveLength(6);
    expect(d.weeklyActivity.reduce((a, w) => a + w.transitions, 0)).toBe(10);
    expect(d.stageTransitions[0]).toMatchObject({ from: '-', to: 'Evaluated', count: 3 });
  });

  it('computes an all-zero dashboard for an empty tracker without dividing by zero', () => {
    const d = computeDashboard([], []);
    expect(d.totals).toMatchObject({ applications: 0, scored: 0, averageScore: null });
    expect(d.rates).toEqual({ evaluatedToApplied: null, appliedToInterview: null, interviewToOffer: null });
    expect(d.funnel.every((f) => f.count === 0)).toBe(true);
    expect(d.topCompanies).toEqual([]);
  });

  it('classifies work mode strings', () => {
    expect(workModeOf('hybrid (Austin)')).toBe('hybrid');
    expect(workModeOf('full remote')).toBe('remote');
    expect(workModeOf('onsite (NYC)')).toBe('onsite');
    expect(workModeOf(null)).toBe('unknown');
  });
});

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseDigest, parseDailyLog, parseCompanyFile, readImmigrationOverview, listLogDates, daysBetween } from '../../server/domains/immigration.js';
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

  it('classifies work mode strings', () => {
    expect(workModeOf('hybrid (Austin)')).toBe('hybrid');
    expect(workModeOf('full remote')).toBe('remote');
    expect(workModeOf('onsite (NYC)')).toBe('onsite');
    expect(workModeOf(null)).toBe('unknown');
  });
});

// Insights > Progress's funnel is the cumulative-stage contract of upstream funnel-stages.mjs ("shared by CLI
// statistics and web views"): Rejected proves an application and a reply, a ledger line counts both its from and its
// to state, and a current SKIP row stays out of the funnel. stats.mjs computeFunnelWithHistory is that contract's CLI
// reading, so the dashboard's Applied, Responded, Interview and Offer counts and its applied-to-interview rate must
// equal it (SW-web-b-08).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { computeDashboard, loadFunnelStages, type FunnelStages, type StatusLogRow } from '../../server/domains/insights.js';
import type { TrackerRow } from '../../server/domains/tracker.js';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';

type Funnel = { everApplied: number; everResponded: number; everInterview: number; everOffer: number; interviewRate: number };
let stages: FunnelStages;
let upstream: (statusByNum: Map<number, string>, ledger: Array<{ num: number; from: string; to: string }>) => Funnel;
beforeAll(async () => {
  stages = await loadFunnelStages(DEFAULT_CODE_ROOT);
  upstream = ((await import(pathToFileURL(path.join(DEFAULT_CODE_ROOT, 'stats.mjs')).href)) as { computeFunnelWithHistory: typeof upstream }).computeFunnelWithHistory;
});

const row = (num: number, status: string, score: number | null = 4): TrackerRow =>
  ({ num, date: '2026-09-20', company: `Co ${num}`, role: 'Engineer', score, scoreRaw: score === null ? 'N/A' : `${score}/5`, status, pdf: false, pdfRaw: '❌', report: score === null ? null : num, reportLabel: null, notes: '', location: null, url: null, posted: null, lastContact: null, summary: null, reportState: 'none' }) as TrackerRow;
const step = (num: number, from: string, to: string): StatusLogRow => ({ num, date: '2026-09-25', from, to, source: 'set-status', note: '' });
const count = (d: ReturnType<typeof computeDashboard>, stage: string) => d.funnel.find((f) => f.stage === stage)!.count;

function expectParity(rows: TrackerRow[], log: StatusLogRow[]) {
  const d = computeDashboard(rows, log, stages);
  const u = upstream(new Map(rows.map((r) => [r.num, r.status])), log.map(({ num, from, to }) => ({ num, from, to })));
  expect({ applied: count(d, 'Applied'), responded: count(d, 'Responded'), interview: count(d, 'Interview'), offer: count(d, 'Offer') }).toEqual({ applied: u.everApplied, responded: u.everResponded, interview: u.everInterview, offer: u.everOffer });
  expect(d.rates.appliedToInterview).toBe(u.everApplied ? u.interviewRate : null);
  return d;
}

describe('the Insights funnel', () => {
  it('given six applications rejected after Applied and one that reached Interview, then all seven applied and responded, and the interview rate is 14.3%', () => {
    const rows = [...[1, 2, 3, 4, 5, 6].map((n) => row(n, 'Rejected')), row(7, 'Interview')];
    const log = [...[1, 2, 3, 4, 5, 6].map((n) => step(n, 'Applied', 'Rejected')), step(7, 'Applied', 'Interview')];
    const d = expectParity(rows, log);
    expect(d.funnel.slice(1, 4)).toEqual([
      { stage: 'Applied', count: 7 },
      { stage: 'Responded', count: 7 },
      { stage: 'Interview', count: 1 },
    ]);
    expect(d.rates.appliedToInterview).toBe(14.3);
  });

  it('given a row now Discarded whose ledger shows it reached Offer, then it counts through Offer', () => {
    const d = expectParity([row(1, 'Discarded')], [step(1, 'Interview', 'Offer'), step(1, 'Offer', 'Discarded')]);
    expect(count(d, 'Offer')).toBe(1);
  });

  it('given a current SKIP row, then it is outside the funnel, Evaluated included, whatever its ledger says', () => {
    const d = expectParity([row(1, 'SKIP'), row(2, 'Evaluated')], [step(1, 'Applied', 'SKIP')]);
    expect(count(d, 'Evaluated')).toBe(1);
    expect(count(d, 'Applied')).toBe(0);
  });

  it('given a ledger line for a row no longer in the tracker, then it counts nowhere', () => {
    const d = expectParity([row(1, 'Applied')], [step(9, 'Applied', 'Interview')]);
    expect(count(d, 'Interview')).toBe(0);
  });

  it('given a Hired row, then it counts in every stage through Hired', () => {
    const d = expectParity([row(1, 'Hired')], []);
    expect(d.funnel.map((f) => f.count)).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

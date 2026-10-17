// Discover > Network scan reads the one JSON object scan-ats-full --json prints on stdout.
import { describe, expect, it } from 'vitest';
import { parseScanOutput, scanDegradations } from '@web/features/discover/DiscoverPage';

const stdout = (obj: unknown, seq = 1) => ({ line: JSON.stringify(obj), stream: 'stdout' as const, seq, ts: '2026-10-05T12:00:00.000Z' });

describe('network scan output', () => {
  it('a sweep the scanner stopped on a DNS outage (stoppedByOutage) reads as stopped early, like a SIGTERM partial', () => {
    expect(parseScanOutput([stdout({ offers: [], capHit: false, stoppedByOutage: true })])?.stoppedEarly).toBe(true);
    expect(parseScanOutput([stdout({ postings: [], stoppedEarly: true })])?.stoppedEarly).toBe(true);
  });

  it('a sweep that finished its sources is not stopped early', () => {
    expect(parseScanOutput([stdout({ offers: [{ url: 'https://a.example/1', company: 'A', title: 'T' }], capHit: false, stoppedByOutage: false })])).toMatchObject({ stoppedEarly: false, postings: [{ url: 'https://a.example/1' }] });
  });
});

describe('network scan undated postings (R27-feat-a-L2-01)', () => {
  it('reads postingsDroppedNoDate from the scanner summary', () => {
    expect(parseScanOutput([stdout({ offers: [], postingsKept: 0, postingsDroppedNoDate: 7 })])?.postingsDroppedNoDate).toBe(7);
  });

  // The count is taken before the title filter, so nearly every real scan has some: withholding the empty state on it
  // would hide "No postings matched" from almost every zero-match scan (R27-feat-a-L2-01 review).
  it('a scan that skipped undated postings says so beside the "no postings matched" empty state, without withholding it', () => {
    const summary = parseScanOutput([stdout({ offers: [], postingsKept: 0, postingsDroppedNoDate: 3 })]);
    const degraded = scanDegradations(summary!);
    expect(degraded.notes.join(' ')).toMatch(/3 undated postings were skipped/);
    expect(degraded.noData).toBe(false);
  });

  it('a scan that skipped no undated postings adds no note', () => {
    const degraded = scanDegradations(parseScanOutput([stdout({ offers: [], postingsDroppedNoDate: 0 })])!);
    expect(degraded).toEqual({ notes: [], noData: false });
  });
});

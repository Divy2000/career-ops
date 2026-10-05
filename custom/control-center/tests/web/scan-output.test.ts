// Discover > Network scan reads the one JSON object scan-ats-full --json prints on stdout.
import { describe, expect, it } from 'vitest';
import { parseScanOutput } from '@web/features/discover/DiscoverPage';

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

// Tracker > sort by Status: a status templates/states.yml does not know sorts after the known ones, as the server's
// statusRank and the grouped view place it, in either direction it sits at the far end from Interview (R25-feat-c-L2-01).
import { describe, expect, it } from 'vitest';
import type { TrackerRow } from '@shared/api';
import { sortRows } from '@web/features/tracker/TrackerPage';

const row = (num: number, status: string): TrackerRow => ({
  num, date: '2026-09-20', company: `Co ${num}`, role: 'Engineer', score: 4, scoreRaw: '4.0/5', status,
  pdf: false, pdfRaw: '-', report: null, reportLabel: null, notes: '', location: null, url: null, posted: null, lastContact: null, summary: null, reportState: 'none',
});

const rows = [row(1, 'On hold'), row(2, 'Interview'), row(3, 'SKIP')];

describe('tracker status sort', () => {
  it('puts an unknown status after the known ones when ascending', () => {
    expect(sortRows(rows, 'status', 'asc').map((r) => r.status)).toEqual(['Interview', 'SKIP', 'On hold']);
  });

  it('puts an unknown status first when descending, the mirror of ascending', () => {
    expect(sortRows(rows, 'status', 'desc').map((r) => r.status)).toEqual(['On hold', 'SKIP', 'Interview']);
  });

  it('keeps each unknown status together instead of interleaving them by row number', () => {
    const mixed = [row(1, 'Paused'), row(2, 'On hold'), row(3, 'Paused'), row(4, 'Applied'), row(5, 'On hold')];
    expect(sortRows(mixed, 'status', 'asc').map((r) => r.num)).toEqual([4, 2, 5, 1, 3]);
    expect(sortRows(mixed, 'status', 'desc').map((r) => r.num)).toEqual([1, 3, 2, 5, 4]);
  });
});

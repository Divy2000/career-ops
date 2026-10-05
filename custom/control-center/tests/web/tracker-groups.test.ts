// Tracker > grouped view (v): every visible row sits in a status group, the server's states.yml labels in lifecycle
// order and any status states.yml does not know after them, so no row drops out of the table (SW-web-a-02).
import { describe, expect, it } from 'vitest';
import type { TrackerRow } from '@shared/api';
import { statusGroups } from '@web/features/tracker/TrackerPage';

const row = (num: number, status: string): TrackerRow => ({
  num, date: '2026-09-20', company: `Co ${num}`, role: 'Engineer', score: 4, scoreRaw: '4.0/5', status,
  pdf: false, pdfRaw: '-', report: null, reportLabel: null, notes: '', location: null, url: null, posted: null, lastContact: null, summary: null, reportState: 'none',
});

describe('tracker grouped view', () => {
  it('groups the canonical labels in lifecycle order', () => {
    const groups = statusGroups([row(1, 'Applied'), row(2, 'Interview'), row(3, 'Applied')]);
    expect(groups.map((g) => [g.status, g.rows.map((r) => r.num)])).toEqual([
      ['Interview', [2]],
      ['Applied', [1, 3]],
    ]);
  });

  it('keeps a row whose status states.yml does not know, in its own group after the known ones', () => {
    const groups = statusGroups([row(1, 'On hold forever'), row(2, 'SKIP'), row(3, 'On hold forever'), row(4, 'Waitlisted')]);
    expect(groups.map((g) => [g.status, g.rows.map((r) => r.num)])).toEqual([
      ['SKIP', [2]],
      ['On hold forever', [1, 3]],
      ['Waitlisted', [4]],
    ]);
  });
});

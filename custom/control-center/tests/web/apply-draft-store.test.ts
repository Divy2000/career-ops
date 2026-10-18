// The Apply page's per-draft storage (web/features/apply/draftStore.ts): one format per key, read back only when it is
// well formed, and released together, so a draft the page lets go of leaves nothing a later draft reads.
import { beforeEach, describe, expect, it } from 'vitest';
import { forgetDraft, readDraftDocs, readSessionRow, readTypedUrl, startedForOther, writeDraftDocs, writeSessionRow, writeTypedUrl } from '@web/features/apply/draftStore';

const ACME = { company: 'Acme Robotics', role: 'Robotics Engineer', report: 31 };
const BETA = { company: 'Beta Labs', role: 'Data Engineer', report: 44 };

beforeEach(() => sessionStorage.clear());

describe('Given what is stored beside a draft session', () => {
  it.each([
    ['both picks', { pdf: 'output/cv.pdf', cover: 'output/cover.md' }, { pdf: 'output/cv.pdf', cover: 'output/cover.md' }],
    ['an explicit None for both', { pdf: '', cover: '' }, { pdf: '', cover: '' }],
    ['no choice made', { pdf: null, cover: null }, { pdf: null, cover: null }],
  ])('When %s is written, Then it reads back the same', (_name, docs, expected) => {
    writeDraftDocs('s1', docs);
    expect(readDraftDocs('s1')).toEqual(expected);
  });

  it.each([
    ['not JSON', '{pdf', null],
    ['JSON null', 'null', null],
    ['a number', '7', null],
    ['non-string picks', JSON.stringify({ pdf: 3, cover: true }), { pdf: null, cover: null }],
  ])('When the documents entry is %s, Then it reads as no stored choice', (_name, raw, expected) => {
    sessionStorage.setItem('cc.apply.docs.s1', raw);
    expect(readDraftDocs('s1')).toEqual(expected);
  });

  it.each([
    ['not JSON', '{'],
    ['JSON null', 'null'],
    ['no role', JSON.stringify({ company: 'Acme', report: 1 })],
    ['a string report', JSON.stringify({ company: 'Acme', role: 'Eng', report: '31' })],
  ])('When the row marker is %s, Then no application is read', (_name, raw) => {
    sessionStorage.setItem('cc.apply.row.s1', raw);
    expect(readSessionRow('s1')).toBeNull();
  });

  it('When a row with no report is written, Then it reads back with report null, and only its identity is kept', () => {
    // A full tracker row, as the page holds it.
    const row = { ...ACME, report: null, status: 'Evaluated', url: 'https://boards.greenhouse.io/acme/jobs/1' };
    writeSessionRow('s1', row);
    expect(readSessionRow('s1')).toEqual({ ...ACME, report: null });
  });

  it('When the draft is forgotten, Then every key kept beside it goes, and another draft\'s stay', () => {
    for (const sid of ['s1', 's2']) {
      writeTypedUrl(sid, `https://boards.greenhouse.io/acme/jobs/${sid}`);
      writeDraftDocs(sid, { pdf: '', cover: null });
      writeSessionRow(sid, ACME);
    }
    forgetDraft('s1');
    expect(Object.keys(sessionStorage).filter((k) => k.endsWith('.s1'))).toEqual([]);
    expect(readTypedUrl('s2')).toBe('https://boards.greenhouse.io/acme/jobs/s2');
    expect(readDraftDocs('s2')).toEqual({ pdf: '', cover: null });
    expect(readSessionRow('s2')).toEqual(ACME);
  });
});

describe('Whether a session was started for another application than the one shown', () => {
  it.each([
    ['no session', null, ACME, undefined, undefined, false],
    ['no identity shown (/apply with no row)', 's1', undefined, ACME, undefined, false],
    ['neither marker nor pin', 's1', ACME, undefined, undefined, false],
    ['a marker for the shown one', 's1', ACME, ACME, undefined, false],
    ['a marker for the earlier owner', 's1', BETA, ACME, undefined, true],
    ['a pin for the shown one over a stale marker', 's1', BETA, ACME, BETA, false],
    ['a pin for the earlier owner over a marker for the shown one', 's1', BETA, BETA, ACME, true],
    ['the same company and role with another report', 's1', { ...ACME, report: 32 }, ACME, undefined, true],
  ] as const)('Given %s', (_name, sid, shown, marker, pinned, expected) => {
    if (sid && marker) writeSessionRow(sid, marker);
    expect(startedForOther(sid, shown, pinned)).toBe(expected);
  });
});

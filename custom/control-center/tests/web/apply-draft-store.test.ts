// The Apply page's per-draft storage (web/features/apply/draftStore.ts): one format per key, read back only when it is
// well formed, and released together, so a draft the page lets go of leaves nothing a later draft reads.
import { beforeEach, describe, expect, it } from 'vitest';
import { forgetDraft, readDraftDocs, readSessionRow, readTypedUrl, startedForOther, writeDraftDocs, writeSessionRow, writeTypedUrl } from '@web/features/apply/draftStore';
import { sameApplication } from '../../server/claude/sessions';

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
    // A report linked to the row after the draft started (R34-feat-a-L1-01): the server's sameApplication holds the row
    // as the same application, so the page must too.
    ['a marker written before the report was linked', 's1', ACME, { ...ACME, report: null }, undefined, false],
    ['a pin written before the report was linked', 's1', ACME, BETA, { ...ACME, report: null }, false],
    ['a marker with a report the shown row has not linked', 's1', { ...ACME, report: null }, ACME, undefined, false],
    ['a marker with no report for another company', 's1', ACME, { ...BETA, report: null }, undefined, true],
    ['a marker with no report for another role', 's1', ACME, { ...ACME, role: 'Data Engineer', report: null }, undefined, true],
  ] as const)('Given %s', (_name, sid, shown, marker, pinned, expected) => {
    if (sid && marker) writeSessionRow(sid, marker);
    expect(startedForOther(sid, shown, pinned)).toBe(expected);
  });
});

// mulberry32: small, seedable, good enough to draw identities.
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Seeded identities: the page and the server agree on which application a session belongs to', () => {
  const SEEDS = 20;
  const DRAWS = 50;
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}: startedForOther is the negation of the server's sameApplication`, () => {
      const rand = prng(seed);
      const pickOf = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
      const draw = () => ({ company: pickOf(['Acme', 'Beta']), role: pickOf(['Eng', 'Data']), report: pickOf([null, 7, 8]) });
      for (let i = 0; i < DRAWS; i++) {
        sessionStorage.clear();
        const shown = draw();
        const recorded = draw();
        const viaPin = rand() < 0.5;
        if (!viaPin) writeSessionRow('s1', recorded);
        const where = `seed ${seed}, draw ${i}: shown ${JSON.stringify(shown)}, ${viaPin ? 'pin' : 'marker'} ${JSON.stringify(recorded)}`;
        expect(startedForOther('s1', shown, viaPin ? recorded : undefined), where).toBe(!sameApplication(recorded, shown));
      }
    });
  }
});

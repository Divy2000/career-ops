// The Pipeline "being evaluated" state holds back what the server's duplicate guard would refuse: a posting by its dedup
// key, under every report-gated mode (R28-feat-b-L2-01).
import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@shared/api';
import { evaluatingTargets, isReportGatedMode } from '../../web/features/pipeline/evaluating';
import { isReportGated } from '../../server/claude/honesty';
import { MODES } from '../../server/claude/modes';

const session = (mode: string, target: SessionMeta['target'], status = 'running'): SessionMeta => ({ id: `s-${mode}`, mode, status, target }) as SessionMeta;

describe('evaluatingTargets', () => {
  it('Given an oferta session on a tracking-param spelling, When the bare posting URL is looked up, Then it is being evaluated', () => {
    const held = evaluatingTargets([session('oferta', { type: 'url', value: 'https://boards.greenhouse.io/acme/jobs/123?utm_source=linkedin' })]);
    expect(held.has('https://boards.greenhouse.io/acme/jobs/123')).toBe(true);
    expect(held.has('https://boards.greenhouse.io/acme/jobs/123/')).toBe(true);
    expect(held.has('https://boards.greenhouse.io/acme/jobs/456')).toBe(false);
  });

  it('Given an auto-pipeline or localized oferta session, When its URL is looked up, Then it is being evaluated', () => {
    for (const mode of ['auto-pipeline', 'de/angebot', 'es/oferta']) {
      expect(evaluatingTargets([session(mode, { type: 'url', value: 'https://jobs.example.com/a' })]).has('https://jobs.example.com/a')).toBe(true);
    }
  });

  it('Given a non-report mode or a finished session on the URL, When it is looked up, Then it is free', () => {
    expect(evaluatingTargets([session('contacto', { type: 'url', value: 'https://jobs.example.com/a' })]).has('https://jobs.example.com/a')).toBe(false);
    expect(evaluatingTargets([session('oferta', { type: 'url', value: 'https://jobs.example.com/a' }, 'done')]).has('https://jobs.example.com/a')).toBe(false);
  });

  it('Given an evaluation of a saved JD, When its reference is looked up, Then only that saved JD is being evaluated', () => {
    const held = evaluatingTargets([session('oferta', { type: 'text', value: 'local:jds/acme.md' })]);
    expect(held.has('local:jds/acme.md')).toBe(true);
    expect(held.has('local:jds/other.md')).toBe(false);
  });

  it('Given no sessions list yet, When anything is looked up, Then it is free', () => {
    expect(evaluatingTargets(undefined).has('https://jobs.example.com/a')).toBe(false);
  });
});

describe('isReportGatedMode', () => {
  it('agrees with the server for every mode id and its language-directory spellings', () => {
    const ids = new Set<string>(['oferta', 'auto-pipeline', 'de/angebot', 'ar/fursah', 'ja/kyujin', 'de/bewerben', 'regional/de', 'pipeline', 'zh-TW/oferta']);
    for (const m of MODES) {
      ids.add(m.id);
      ids.add(`de/${m.id}`);
      ids.add(`zh-TW/${m.id}`);
    }
    for (const id of ids) expect(isReportGatedMode(id), id).toBe(isReportGated(id));
  });
});

describe('evaluatingTargets target types', () => {
  it('Given an evaluation of pasted JD text, When a URL with that text is looked up, Then it is free (the server keys no posting for it)', () => {
    expect(evaluatingTargets([session('oferta', { type: 'text', value: 'https://jobs.example.com/a' })]).has('https://jobs.example.com/a')).toBe(false);
  });
});

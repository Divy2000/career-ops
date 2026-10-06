import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decideTurnOutcome, detectNewReports, endsWithQuestion, ownReports, snapshotReports } from '../../server/claude/honesty.js';
import { parseReservedRange, readOutputLanguage } from '../../server/claude/manager.js';
import { applyRememberedFact, NOTES_END, NOTES_START } from '../../server/domains/memory.js';
import { copyFixtureRoot } from '../helpers/app.js';

const base = { modeId: 'oferta', policyClass: 'evaluate' as const, cancelled: false, exitCode: 0, isError: false, sawResult: true, finalText: 'Scored 4.1/5.', envelopeCount: 0, newReports: [], resumed: false, answersSeen: false, reportProduced: false };

describe('evaluation honesty gate', () => {
  it('snapshots real reports only and detects new ones with their header score', () => {
    const root = copyFixtureRoot();
    const before = snapshotReports(root);
    expect(before.has('005-RESERVED.md')).toBe(false);
    expect(before.has('001-acme-robotics.md')).toBe(true);
    fs.writeFileSync(path.join(root, 'reports', '009-RESERVED.md'), '');
    fs.writeFileSync(path.join(root, 'reports', '010-new-co.md'), '# Evaluation: New Co\n\n**Date:** 2026-10-03\n**Score:** 4.4/5\n\n## A) Role Summary\nx\n');
    const fresh = detectNewReports(root, before);
    expect(fresh).toEqual([{ num: 10, file: '010-new-co.md', score: 4.4 }]);
    expect(detectNewReports(root, new Set())).toHaveLength(7);
  });

  it('credits a turn only with its own report: the reserved number when it has one, else a report in its own files log', () => {
    const found = [
      { num: 42, file: '042-acme.md', score: 4 },
      { num: 43, file: '043-globex.md', score: 3.5 },
    ];
    expect(ownReports(found, { reportNum: 42, turnFiles: [] })).toEqual([found[0]]);
    expect(ownReports(found, { reportNum: 44, turnFiles: ['reports/043-globex.md'] })).toEqual([]);
    expect(ownReports(found, { reportNum: null, turnFiles: ['reports/043-globex.md', 'output/x.pdf'] })).toEqual([found[1]]);
    expect(ownReports(found, { reportNum: null, turnFiles: ['jds/043-globex.md'] })).toEqual([]);
    expect(ownReports(found, { reportNum: null, turnFiles: [] })).toEqual([]);
  });

  it('requires a clean exit, output and a new report for an evaluation to be done', () => {
    expect(decideTurnOutcome({ ...base, newReports: [{ num: 8, file: '008-x.md', score: 4.1 }] }).status).toBe('done');
    expect(decideTurnOutcome(base)).toMatchObject({ status: 'awaiting_user', reason: expect.stringMatching(/no new report/) });
    expect(decideTurnOutcome({ ...base, finalText: '', newReports: [{ num: 8, file: '008-x.md', score: null }] }).status).toBe('awaiting_user');
    expect(decideTurnOutcome({ ...base, exitCode: 1 })).toMatchObject({ status: 'error', reason: 'claude exited 1' });
    expect(decideTurnOutcome({ ...base, isError: true }).status).toBe('error');
    expect(decideTurnOutcome({ ...base, sawResult: false }).status).toBe('error');
    expect(decideTurnOutcome({ ...base, cancelled: true, exitCode: null }).status).toBe('cancelled');
  });

  it('regional/eu-swe is advisory and writes no report: its turns end on the question rule (SW2-claude-04)', () => {
    const euSwe = { ...base, modeId: 'regional/eu-swe' };
    expect(decideTurnOutcome({ ...euSwe, finalText: 'Calibration addendum: target Berlin and Amsterdam first.' })).toMatchObject({ status: 'done', reason: 'clean exit with output' });
    expect(decideTurnOutcome({ ...euSwe, finalText: 'Which country is the role in?' }).status).toBe('awaiting_user');
  });

  it('an evaluation owes its report once: a follow-up turn after it answers like any turn (SW2-claude-03)', () => {
    const followUp = { ...base, reportProduced: true };
    expect(decideTurnOutcome({ ...followUp, finalText: 'Block D scored low because the stack overlaps only partly.' })).toMatchObject({ status: 'done', reason: 'clean exit with output' });
    expect(decideTurnOutcome({ ...followUp, finalText: 'Shall I also save the JD?' }).status).toBe('awaiting_user');
    // Until a report exists, every turn still owes it.
    expect(decideTurnOutcome({ ...base, finalText: 'Block D scored low.' })).toMatchObject({ status: 'awaiting_user', reason: expect.stringMatching(/no new report/) });
  });

  it('a localized evaluation is report-gated like oferta, whatever its file is called', () => {
    for (const modeId of ['de/angebot', 'fr/offre', 'ja/kyujin', 'tr/is-ilani', 'es/oferta']) {
      expect(decideTurnOutcome({ ...base, modeId }), modeId).toMatchObject({ status: 'awaiting_user', reason: expect.stringMatching(/no new report/) });
      expect(decideTurnOutcome({ ...base, modeId, newReports: [{ num: 8, file: '008-x.md', score: 4.1 }] }).status, modeId).toBe('done');
    }
    // A pipeline or a live application assistant is not one evaluation: no report needed (the assistant waits for its
    // answers envelope instead, SW-claude-03 review).
    expect(decideTurnOutcome({ ...base, modeId: 'de/pipeline' }).status).toBe('done');
    expect(decideTurnOutcome({ ...base, modeId: 'de/bewerben' })).toMatchObject({ status: 'awaiting_user', reason: 'no terminal envelope in the output' });
  });

  it('advisor and ai-search may end in prose: an answer is done, a question waits, and no envelope is required', () => {
    const ask = { ...base, modeId: 'advisor', policyClass: 'read-only' as const };
    expect(decideTurnOutcome({ ...ask, finalText: 'Your strongest match this week is Acme Robotics (4.4/5).' })).toMatchObject({ status: 'done', reason: 'clean exit with output' });
    expect(decideTurnOutcome({ ...ask, finalText: 'Two rows match. Which one do you mean?' }).status).toBe('awaiting_user');
    expect(decideTurnOutcome({ ...ask, envelopeCount: 1 }).status).toBe('done');
    const search = { ...base, modeId: 'ai-search', policyClass: 'read-only' as const };
    expect(decideTurnOutcome({ ...search, finalText: 'No postings matched these filters.' }).status).toBe('done');
    expect(decideTurnOutcome({ ...search, envelopeCount: 3 }).status).toBe('done');
    // The modes whose contract demands an envelope still wait without one.
    for (const modeId of ['apply', 'cv-ingest', 'projects-ingest']) expect(decideTurnOutcome({ ...base, modeId, policyClass: 'read-only' }), modeId).toMatchObject({ status: 'awaiting_user', reason: 'no terminal envelope in the output' });
  });

  it('a localized apply mode is envelope-gated like apply: no answers envelope, no done', () => {
    for (const modeId of ['de/bewerben', 'fr/postuler', 'ru/apply', 'zh-TW/apply']) {
      expect(decideTurnOutcome({ ...base, modeId, policyClass: 'apply', finalText: 'Filled the form.' }), modeId).toMatchObject({ status: 'awaiting_user', reason: 'no terminal envelope in the output' });
      expect(decideTurnOutcome({ ...base, modeId, policyClass: 'apply', envelopeCount: 1 }).status, modeId).toBe('done');
    }
  });

  it('apply waives its answers envelope only on a turn that follows delivered answers: the fill turn reports in prose (SW2-tests-20)', () => {
    for (const modeId of ['apply', 'de/bewerben']) {
      const apply = { ...base, modeId, policyClass: 'apply' as const };
      const filled = 'Filled 3 fields. Stopped before Submit: you press it.';
      expect(decideTurnOutcome({ ...apply, resumed: true, answersSeen: true, finalText: filled }), modeId).toMatchObject({ status: 'done', reason: 'clean exit with output' });
      expect(decideTurnOutcome({ ...apply, resumed: true, answersSeen: true, finalText: 'The form has a new required field. What should it say?' }).status, modeId).toBe('awaiting_user');
      // Review (SW2-tests-20): a resumed turn with no answers delivered yet (a login wall, a failed first turn) still needs them.
      expect(decideTurnOutcome({ ...apply, resumed: true, answersSeen: false, finalText: filled }), modeId).toMatchObject({ status: 'awaiting_user', reason: 'no terminal envelope in the output' });
      expect(decideTurnOutcome({ ...apply, resumed: false, answersSeen: false, finalText: 'Read the form.' }), modeId).toMatchObject({ status: 'awaiting_user', reason: 'no terminal envelope in the output' });
    }
    // Modes whose every turn ends in an envelope keep needing one.
    for (const modeId of ['cv-ingest', 'projects-ingest']) expect(decideTurnOutcome({ ...base, modeId, policyClass: 'read-only', resumed: true, answersSeen: true }).status, modeId).toBe('awaiting_user');
  });

  it('envelope modes need a terminal envelope; other modes wait when the turn ends with a question', () => {
    expect(decideTurnOutcome({ ...base, modeId: 'apply', policyClass: 'apply', envelopeCount: 1 }).status).toBe('done');
    expect(decideTurnOutcome({ ...base, modeId: 'apply', policyClass: 'apply' }).status).toBe('awaiting_user');
    expect(decideTurnOutcome({ ...base, modeId: 'interview/practice', policyClass: 'interview', finalText: 'Ready.\nWhich company is this for?' }).status).toBe('awaiting_user');
    expect(decideTurnOutcome({ ...base, modeId: 'interview/practice', policyClass: 'interview', finalText: 'All set. Good luck.' }).status).toBe('done');
    expect(endsWithQuestion('Is this right?\n\n')).toBe(true);
    expect(endsWithQuestion('Questions? No. Done.')).toBe(false);
  });

  it('parses reserve-report-num output and the profile output language', () => {
    expect(parseReservedRange('008-010\n')).toEqual([8, 9, 10]);
    expect(parseReservedRange('Reserved: 012')).toEqual([12]);
    expect(parseReservedRange('nothing')).toEqual([]);
    const root = copyFixtureRoot();
    expect(readOutputLanguage(root)).toBe('en');
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'profile.yml'), 'language:\n  output: es\n');
    expect(readOutputLanguage(root)).toBe('es');
  });
});

describe('remembered facts', () => {
  it('creates the managed block, appends inside it and dedupes', () => {
    const first = applyRememberedFact('# Profile\n', 'Prefers remote roles');
    expect(first.result).toBe('ok');
    expect(first.text).toContain(`${NOTES_START}\n- Prefers remote roles\n${NOTES_END}`);
    const second = applyRememberedFact(first.text, 'Open to Berlin');
    expect(second.text.indexOf('- Open to Berlin')).toBeGreaterThan(second.text.indexOf('- Prefers remote roles'));
    expect(second.text.indexOf('- Open to Berlin')).toBeLessThan(second.text.indexOf(NOTES_END));
    expect(applyRememberedFact(second.text, 'Open to  Berlin').result).toBe('deduped');
    expect(applyRememberedFact('', '   ').result).toBe('deduped');
  });

  it('a fact that is only part of a remembered line (it may contradict it) is written, and a whole line is not (SW3-tests-25)', () => {
    const md = `# Profile\n\n## Notes from the web assistant\n${NOTES_START}\n- Not open to relocation\n${NOTES_END}\n`;
    const r = applyRememberedFact(md, 'open to relocation');
    expect(r.result).toBe('ok');
    expect(r.text).toContain(`- Not open to relocation\n- open to relocation\n${NOTES_END}`);
    expect(applyRememberedFact(r.text, 'Not open to relocation').result).toBe('deduped');
    // Before the block exists, the same rule over the profile's own lines.
    expect(applyRememberedFact('# Profile\n\nNot open to relocation\n', 'open to relocation').result).toBe('ok');
    expect(applyRememberedFact('# Profile\n\n- Open to Berlin\n', 'Open to Berlin').result).toBe('deduped');
  });
});

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decideTurnOutcome, detectNewReports, endsWithQuestion, snapshotReports } from '../../server/claude/honesty.js';
import { parseReservedRange, readOutputLanguage } from '../../server/claude/manager.js';
import { applyRememberedFact, NOTES_END, NOTES_START } from '../../server/domains/memory.js';
import { copyFixtureRoot } from '../helpers/app.js';

const base = { modeId: 'oferta', policyClass: 'evaluate' as const, cancelled: false, exitCode: 0, isError: false, sawResult: true, finalText: 'Scored 4.1/5.', envelopeCount: 0, newReports: [] };

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

  it('requires a clean exit, output and a new report for an evaluation to be done', () => {
    expect(decideTurnOutcome({ ...base, newReports: [{ num: 8, file: '008-x.md', score: 4.1 }] }).status).toBe('done');
    expect(decideTurnOutcome(base)).toMatchObject({ status: 'awaiting_user', reason: expect.stringMatching(/no new report/) });
    expect(decideTurnOutcome({ ...base, finalText: '', newReports: [{ num: 8, file: '008-x.md', score: null }] }).status).toBe('awaiting_user');
    expect(decideTurnOutcome({ ...base, exitCode: 1 })).toMatchObject({ status: 'error', reason: 'claude exited 1' });
    expect(decideTurnOutcome({ ...base, isError: true }).status).toBe('error');
    expect(decideTurnOutcome({ ...base, sawResult: false }).status).toBe('error');
    expect(decideTurnOutcome({ ...base, cancelled: true, exitCode: null }).status).toBe('cancelled');
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
});

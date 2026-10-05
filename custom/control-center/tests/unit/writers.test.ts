import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { applyInboxSkip, postingUrl } from '../../server/domains/inboxSkip.js';
import { applyFollowupEdit } from '../../server/domains/followups-edit.mjs';
import { ACTIONS, findAction } from '../../server/actions/registry.js';
import { tmpInputDir } from '../../server/actions/tmp-inputs.js';
import { copyFixtureRoot } from '../helpers/app.js';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';

const PIPELINE = `# Pipeline\n\n## Pending\n\n- [ ] https://a.example/1 | A | Role\n- [x] https://a.example/2 | B | Role\n- not a checkbox\n\n## Done\n\n- [ ] https://a.example/1 | A | Role\n`;

describe('inbox skip port', () => {
  it('accepts only http(s) posting URLs', () => {
    expect(postingUrl('https://a.example/1')).toBe('https://a.example/1');
    expect(postingUrl('file:///etc/passwd')).toBeNull();
    expect(postingUrl('javascript:alert(1)')).toBeNull();
    expect(postingUrl('https://user:pw@a.example/1')).toBeNull();
    expect(postingUrl('not a url')).toBeNull();
  });
  it('flips only the matching Pending row and keeps every other byte', () => {
    const r = applyInboxSkip(PIPELINE, 'https://a.example/1', true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matched).toBe(1);
    expect(r.changed).toBe(1);
    expect(r.text).toBe(PIPELINE.replace('- [ ] https://a.example/1 | A | Role\n- [x]', '- [x] https://a.example/1 | A | Role\n- [x]'));
    expect(r.text.endsWith('## Done\n\n- [ ] https://a.example/1 | A | Role\n')).toBe(true);
  });
  it('undo flips back and a no-op change still counts as matched', () => {
    const r = applyInboxSkip(PIPELINE, 'https://a.example/2', false);
    expect(r).toMatchObject({ ok: true, matched: 1, changed: 1 });
    const same = applyInboxSkip(PIPELINE, 'https://a.example/2', true);
    expect(same).toMatchObject({ ok: true, matched: 1, changed: 0 });
  });
  it('reports unmatched and invalid URLs', () => {
    expect(applyInboxSkip(PIPELINE, 'https://a.example/nope', true)).toEqual({ ok: false, error: 'unmatched' });
    expect(applyInboxSkip(PIPELINE, 'ftp://a.example/1', true)).toEqual({ ok: false, error: 'invalid-url' });
  });
});

const FOLLOWUPS = `# Follow-up History\n\n| num | appNum | date | company | role | channel | contact | notes |\n|---|---|---|---|---|---|---|---|\n| 1 | 1 | 2026-09-28 | Acme | Eng | Email | hr@acme.example | asked |\n| 2 | 6 | 2026-10-02 | Vandelay | Eng | LinkedIn | HM | thanks |\n- next #1 2026-10-10 (set 2026-10-01) ${String.fromCharCode(0x2014)} waiting\n`;

describe('follow-ups edits', () => {
  it('appends a log row with the next num right after the table', () => {
    const r = applyFollowupEdit(FOLLOWUPS, { op: 'log.add', appNum: 6, date: '2026-10-03', company: 'Vandelay', role: 'Eng', channel: 'Email', contact: 'HM', notes: 'sent | deck' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lines = r.text.split('\n');
    expect(lines[6]).toBe('| 3 | 6 | 2026-10-03 | Vandelay | Eng | Email | HM | sent / deck |');
    expect(lines[7]).toMatch(/^- next #1 2026-10-10/);
    expect(r.num).toBe(3);
  });
  it('creates the table when the file is empty', () => {
    const r = applyFollowupEdit('', { op: 'log.add', appNum: 2, date: '2026-10-03', company: 'N', role: 'R', channel: 'Email', contact: '', notes: '' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain('| num | appNum | date | company | role | channel | contact | notes |');
    expect(r.text).toContain('| 1 | 2 | 2026-10-03 | N | R | Email |  |  |');
  });
  it('deletes a log row by num and reports unknown nums', () => {
    const r = applyFollowupEdit(FOLLOWUPS, { op: 'log.delete', num: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).not.toContain('| 2 | 6 |');
    expect(r.text).toContain('| 1 | 1 |');
    expect(applyFollowupEdit(FOLLOWUPS, { op: 'log.delete', num: 9 })).toEqual({ ok: false, error: 'not-found' });
  });
  it('sets a pin by replacing the previous one and clears it', () => {
    const set = applyFollowupEdit(FOLLOWUPS, { op: 'pin.set', appNum: 1, date: '2026-10-20', setOn: '2026-10-03' });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.text.match(/^- next #1 /gm)).toHaveLength(1);
    expect(set.text).toContain('- next #1 2026-10-20 (set 2026-10-03)');
    const cleared = applyFollowupEdit(set.text, { op: 'pin.clear', appNum: 1 });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.text).not.toMatch(/^- next #1 /m);
    expect(applyFollowupEdit(FOLLOWUPS, { op: 'pin.clear', appNum: 4 })).toEqual({ ok: false, error: 'not-found' });
  });
  it('rejects dates that are not YYYY-MM-DD', () => {
    expect(applyFollowupEdit(FOLLOWUPS, { op: 'pin.set', appNum: 1, date: 'tomorrow', setOn: '2026-10-03' })).toEqual({ ok: false, error: 'invalid-date' });
  });
});

/** Every action id the spec's section 3.3 table lists. */
export const SPEC_ACTION_IDS = [
  'tracker.setStatus', 'tracker.delete', 'tracker.verify', 'tracker.normalize', 'tracker.dedup', 'tracker.merge', 'tracker.reconcile', 'tracker.syncCheck', 'tracker.hiredShare', 'tracker.hiredMark',
  // Batch evaluation (3.3 pipeline.batchRun) is the sessions fan-out now: batch-runner.sh's workers run outside any guard.
  'pipeline.prioritize', 'pipeline.rank', 'pipeline.shortlist', 'pipeline.reserveReportNums', 'pipeline.releaseReportNums',
  'scan.portals', 'scan.network', 'scan.full', 'scan.hn', 'scan.interamt', 'scan.funded', 'scan.reposts',
  'portals.validate', 'portals.verify', 'portals.audit', 'portals.fixSlugs',
  'immigration.watch', 'immigration.freshness', 'immigration.h1b',
  'docs.renderPdf', 'docs.coverPdf', 'docs.archivePosting', 'docs.liveness', 'docs.fetchJd', 'docs.prepareApplication', 'docs.appArtifactsInit', 'docs.imgToPdf',
  'insights.stats', 'insights.funnelVelocity', 'insights.analyzePatterns', 'insights.salaryGap', 'insights.upskill', 'insights.companyHistory', 'insights.rejectionLatency', 'insights.processQuality', 'insights.weeklyDigest', 'insights.assessmentLog', 'insights.keywordMatch', 'insights.jdSkillGap', 'insights.storyProvenance', 'insights.inviteMatch', 'insights.linkedinJoin', 'insights.contacts',
  'followups.seed', 'followups.replyPaste', 'followups.replyWatch', 'followups.inviteMatch', 'followups.contactsVcf', 'followups.linkedinJoin',
  'plugins.list', 'plugins.run', 'plugins.audit',
  'system.doctor', 'system.updateStatus', 'system.updateCheck', 'system.updateApply', 'system.updateDismiss', 'system.rollback',
  'daily.runNow', 'devchat.installDeps',
];

describe('action registry covers section 3.3', () => {
  // Builders may stage ephemeral input files under the data root, so it must exist.
  const ctx = { codeRoot: '/code', dataRoot: copyFixtureRoot(), tmpInputs: [] as string[] };
  it.each(SPEC_ACTION_IDS)('%s is registered', (id) => {
    expect(findAction(id), id).toBeDefined();
  });
  it('every action builds an argv array with no shell metacharacters and a code-root cwd', () => {
    for (const a of ACTIONS) {
      const sample = sampleParams(a.id);
      const parsed = a.params.safeParse(sample);
      expect(parsed.success, `${a.id} sample params ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);
      const cmd = a.build(parsed.data, ctx);
      expect(cmd.cwd).toBe('/code');
      expect(Array.isArray(cmd.args)).toBe(true);
      for (const arg of cmd.args) expect(arg, `${a.id} arg ${arg}`).not.toMatch(/[;&|`$><]/);
      expect(['free', 'network', 'tokens']).toContain(a.cost);
    }
  });
  it('no action runs batch/batch-runner.sh: Pipeline > Batch starts confined sessions through the fan-out instead', () => {
    expect(findAction('pipeline.batchRun')).toBeUndefined();
    for (const a of ACTIONS) {
      const cmd = a.build(a.params.parse(sampleParams(a.id)), ctx);
      expect([cmd.bin, ...cmd.args].join(' '), a.id).not.toMatch(/batch-runner/);
    }
  });
  it('destructive actions carry a confirm text', () => {
    for (const id of ['system.updateApply', 'system.rollback', 'tracker.delete', 'portals.fixSlugs']) expect(findAction(id)!.confirm, id).toBeTruthy();
  });
  it('builds the contracted argv for the deterministic writers', () => {
    const del = findAction('tracker.delete')!.build({ n: 3, dryRun: true }, ctx);
    expect(del.args.slice(1)).toEqual(['delete', '--num', '3', '--dry-run']);
    expect(findAction('tracker.delete')!.build({ n: 3, dryRun: false }, ctx).args.slice(1)).toEqual(['delete', '--num', '3']);
    const rank = findAction('pipeline.rank')!.build({ limit: 20, model: 'haiku', dryRun: true }, ctx);
    expect(rank.args[0]).toMatch(/rank-pipeline\.mjs$/);
    expect(rank.args.slice(1)).toEqual(['--limit', '20', '--model', 'haiku', '--dry-run']);
    expect(findAction('tracker.hiredShare')!.build({ report: '012', anonymity: 'role', story: 'It worked' }, ctx).args.slice(1)).toEqual(['--report', '012', '--anonymity', 'role', '--story', 'It worked']);
    expect(findAction('tracker.hiredMark')!.build({ report: '012', mark: 'later' }, ctx).args.slice(1)).toEqual(['--report', '012', '--mark', 'later']);
    // A caller holding the report as a number (12, an unpadded `[12]` row) still works; a padded label stays text.
    for (const id of ['tracker.hiredShare', 'tracker.hiredMark']) {
      const a = findAction(id)!;
      const extra = id === 'tracker.hiredShare' ? { anonymity: 'role' } : { mark: 'later' };
      expect(a.build(a.params.parse({ report: 12, ...extra }), ctx).args.slice(1, 3), id).toEqual(['--report', '12']);
      expect(a.build(a.params.parse({ report: '012', ...extra }), ctx).args.slice(1, 3), id).toEqual(['--report', '012']);
      for (const bad of [0, -3, 1.5, '12a', '']) expect(a.params.safeParse({ report: bad, ...extra }).success, `${id} ${JSON.stringify(bad)}`).toBe(false);
    }
    expect(findAction('pipeline.releaseReportNums')!.build({ range: '12-14' }, ctx).args.slice(1)).toEqual(['--release', '12-14']);
    expect(findAction('tracker.merge')!.build({ dryRun: true, verify: true, backfillUrls: false }, ctx).args.slice(1)).toEqual(['--dry-run', '--verify']);
    expect(findAction('immigration.h1b')!.build({ company: 'Acme', mode: 'json' }, ctx).args.slice(1)).toEqual(['Acme', '--json']);
    expect(findAction('followups.replyPaste')!.build({ subject: 's', from: 'f', body: 'b' }, ctx).args).toContain('--file');
    const render = findAction('docs.renderPdf')!.build({ row: 9, report: 1, html: 'output/a.html', pdf: 'output/a.pdf', format: 'a4' }, ctx);
    expect(render.args.slice(1)).toEqual([path.join(ctx.dataRoot, 'output/a.html'), path.join(ctx.dataRoot, 'output/a.pdf'), '--format=a4', '--report=1']);
    const bundle = 'output/001-acme-robotics-backend/cv/tailored/v002/cv';
    expect(findAction('docs.renderPdf')!.params.safeParse({ row: 1, report: 1, html: `${bundle}.html`, pdf: `${bundle}.pdf` }).success).toBe(true);
    expect(findAction('docs.renderPdf')!.params.safeParse({ row: 1, report: 1, html: 'output/../cv.html', pdf: `${bundle}.pdf` }).success).toBe(false);
    const prefill = findAction('docs.prepareApplication')!;
    expect(prefill.build({ url: 'https://jobs.lever.co/acme/1', pdf: 'output/a.pdf' }, ctx).args.slice(1)).toEqual(['--url', 'https://jobs.lever.co/acme/1', '--pdf', 'output/a.pdf']);
    expect(prefill.build({ url: 'https://jobs.lever.co/acme/1', pdf: 'output/a.pdf', cover: 'output/a-cover.txt' }, ctx).args.slice(1)).toEqual(['--url', 'https://jobs.lever.co/acme/1', '--pdf', 'output/a.pdf', '--cover', 'output/a-cover.txt']);
  });
  it('scan.network writes an ephemeral portals file from the filters and points CAREER_OPS_PORTALS at it', () => {
    const dataRoot = copyFixtureRoot();
    const cmd = findAction('scan.network')!.build({ roles: ['backend'], exclude: ['intern'], locationAllow: ['Remote'], block: [], sinceDays: 7, ats: ['greenhouse', 'lever'], limit: 100 }, { codeRoot: '/code', dataRoot, tmpInputs: [] });
    expect(cmd.args.slice(1)).toEqual(expect.arrayContaining(['--dry-run', '--json', '--since', '7', '--ats', 'greenhouse,lever', '--limit', '100']));
    const portals = cmd.env?.CAREER_OPS_PORTALS;
    expect(portals).toBeDefined();
    expect(portals!.startsWith(path.join(dataRoot, 'data', 'control-center'))).toBe(true);
    const text = fs.readFileSync(portals!, 'utf8');
    expect(text).toContain('- backend');
    expect(text).toContain('- intern');
    expect(text).toContain('- Remote');
  });
  it('scan.network writes title_filter keys the scanner reads: roles keep a title, exclude rejects one', async () => {
    const dataRoot = copyFixtureRoot();
    const cmd = findAction('scan.network')!.build({ roles: ['backend'], exclude: ['intern'], locationAllow: [], block: [], sinceDays: 7, ats: ['greenhouse'], limit: 100 }, { codeRoot: '/code', dataRoot, tmpInputs: [] });
    const config = YAML.parse(fs.readFileSync(cmd.env!.CAREER_OPS_PORTALS!, 'utf8'));
    const { resolveTitleFilterConfig } = (await import(pathToFileURL(path.join(DEFAULT_CODE_ROOT, 'scan-ats-full.mjs')).href)) as { resolveTitleFilterConfig: (c: unknown) => unknown };
    const { buildTitleFilter } = (await import(pathToFileURL(path.join(DEFAULT_CODE_ROOT, 'title-keywords.mjs')).href)) as { buildTitleFilter: (f: unknown) => (title: string) => boolean };
    const keep = buildTitleFilter(resolveTitleFilterConfig(config));
    expect(keep('Backend Engineer')).toBe(true);
    expect(keep('Sales Manager')).toBe(false);
    expect(keep('Backend Intern')).toBe(false);
  });
  it('every input file a build writes is collected for the run to remove, the network scan filters file named only in the env included', () => {
    const dataRoot = copyFixtureRoot();
    const scan = { codeRoot: '/code', dataRoot, tmpInputs: [] as string[] };
    const cmd = findAction('scan.network')!.build({ roles: ['backend'], exclude: [], locationAllow: [], block: [], sinceDays: 7, ats: ['greenhouse'], limit: 100 }, scan);
    expect(scan.tmpInputs).toEqual([cmd.env!.CAREER_OPS_PORTALS]);
    for (const a of ACTIONS) {
      const each = { codeRoot: '/code', dataRoot, tmpInputs: [] as string[] };
      const before = new Set(fs.existsSync(tmpInputDir(dataRoot)) ? fs.readdirSync(tmpInputDir(dataRoot)) : []);
      a.build(a.params.parse(sampleParams(a.id)), each);
      const written = (fs.existsSync(tmpInputDir(dataRoot)) ? fs.readdirSync(tmpInputDir(dataRoot)) : []).filter((f) => !before.has(f)).map((f) => path.join(tmpInputDir(dataRoot), f));
      expect(each.tmpInputs.sort(), a.id).toEqual(written.sort());
    }
  });
});

function sampleParams(id: string): Record<string, unknown> {
  const samples: Record<string, Record<string, unknown>> = {
    'tracker.setStatus': { row: 1, state: 'Applied' },
    'tracker.delete': { n: 1, dryRun: true },
    'tracker.hiredShare': { report: '001', anonymity: 'handle' },
    'tracker.hiredMark': { report: '001', mark: 'never' },
    'pipeline.reserveReportNums': { count: 2 },
    'pipeline.releaseReportNums': { range: '1-2' },
    'scan.network': { roles: ['a'], exclude: [], locationAllow: [], block: [], sinceDays: 7, ats: ['greenhouse'], limit: 50 },
    'scan.seeds': { list: 'yc' },
    'immigration.freshness': { company: 'Acme' },
    'immigration.h1b': { company: 'Acme', mode: 'summary' },
    'docs.renderPdf': { row: 9, report: 1, html: 'output/a.html', pdf: 'output/a.pdf', format: 'letter' },
    'docs.coverPdf': { payloadPath: 'output/p.json' },
    'docs.archivePosting': { n: 1, url: 'https://x.example/1' },
    'docs.liveness': { urls: ['https://x.example/1'] },
    'docs.fetchJd': { url: 'https://x.example/1' },
    'docs.prepareApplication': { url: 'https://x.example/1', pdf: 'output/a.pdf' },
    'docs.appArtifactsInit': { n: 1 },
    'docs.imgToPdf': { file: 'output/a.png' },
    'followups.replyPaste': { subject: 's', from: 'f', body: 'b' },
    'followups.inviteMatch': { text: 'hello' },
    'insights.inviteMatch': { text: 'hello' },
    'insights.jdSkillGap': { text: '- Experience with Python' },
    'projects.rank': { text: 'We need Python.' },
    'followups.contactsVcf': { callerId: 'me' },
    'plugins.run': { id: 'h1b-sponsor', hook: 'check', args: [] },
    'system.updateDismiss': { version: '1.2.3' },
  };
  return samples[id] ?? {};
}

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { applyInboxSkip, postingUrl } from '../../server/domains/inboxSkip.js';
import { appendOffers } from '../../server/domains/writers.js';
import { tempDir } from '../helpers/tmp.js';
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
  it('restoring a skipped needs-JD row writes [!] back, so it keeps its needs-JD state (R12-srv-dom-a-L3-03)', () => {
    const flagged = `## Pending\n\n- [!] https://private.example/job/1 ${String.fromCharCode(0x2014)} Error: login required\n- [ ] https://a.example/9 | A | Role\n`;
    const skipped = applyInboxSkip(flagged, 'https://private.example/job/1', true);
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;
    const restored = applyInboxSkip(skipped.text, 'https://private.example/job/1', false);
    expect(restored).toMatchObject({ ok: true, changed: 1 });
    if (!restored.ok) return;
    expect(restored.text).toBe(flagged);
    const plain = applyInboxSkip(flagged.replace('- [ ] https://a.example/9', '- [x] https://a.example/9'), 'https://a.example/9', false);
    expect(plain.ok && plain.text).toBe(flagged);
    // The localized forms the modes write, and a hand note that is not a fetch error.
    for (const note of ['-- Fehler: Login erforderlich', '-- Erreur : login requis', `${String.fromCharCode(0x2014)} \u9519\u8bef\uff1a\u9700\u8981\u767b\u5f55`]) {
      const r = applyInboxSkip(`## Pending\n- [x] https://b.example/1 ${note}\n`, 'https://b.example/1', false);
      expect(r.ok && r.text, note).toBe(`## Pending\n- [!] https://b.example/1 ${note}\n`);
    }
    const hand = applyInboxSkip('## Pending\n- [x] https://b.example/2 - recruiter asked to wait\n', 'https://b.example/2', false);
    expect(hand.ok && hand.text).toBe('## Pending\n- [ ] https://b.example/2 - recruiter asked to wait\n');
  });
  it('skips a [!] row that waits for its JD, keeping its error note (SW5-tests-02)', () => {
    const text = `## Pending\n\n- [!] https://private.example/job/1 ${String.fromCharCode(0x2014)} Error: login required\n`;
    const r = applyInboxSkip(text, 'https://private.example/job/1', true);
    expect(r).toMatchObject({ ok: true, matched: 1, changed: 1 });
    if (!r.ok) return;
    expect(r.text).toBe(text.replace('- [!]', '- [x]'));
    // Restoring a row that was never checked off changes nothing.
    expect(applyInboxSkip(text, 'https://private.example/job/1', false)).toMatchObject({ ok: true, matched: 1, changed: 0 });
  });
  it('reports unmatched and invalid URLs', () => {
    expect(applyInboxSkip(PIPELINE, 'https://a.example/nope', true)).toEqual({ ok: false, error: 'unmatched' });
    expect(applyInboxSkip(PIPELINE, 'ftp://a.example/1', true)).toEqual({ ok: false, error: 'invalid-url' });
  });
});

const FOLLOWUPS = `# Follow-up History\n\n| num | appNum | date | company | role | channel | contact | notes |\n|---|---|---|---|---|---|---|---|\n| 1 | 1 | 2026-09-28 | Acme | Eng | Email | hr@acme.example | asked |\n| 2 | 6 | 2026-10-02 | Vandelay | Eng | LinkedIn | HM | thanks |\n- next #1 2026-10-10 (set 2026-10-01) ${String.fromCharCode(0x2014)} waiting\n`;

describe('appendOffers', () => {
  it('writes the data root\'s pipeline and scan history it checked, not the files a CAREER_OPS_PIPELINE or _SCAN_HISTORY override names', async () => {
    const root = copyFixtureRoot();
    const decoy = tempDir('cc-append-decoy-');
    const saved = { pipeline: process.env.CAREER_OPS_PIPELINE, history: process.env.CAREER_OPS_SCAN_HISTORY };
    // scan.mjs puts both overrides ahead of the data root; the server's own environment may carry them.
    process.env.CAREER_OPS_PIPELINE = path.join(decoy, 'pipeline.md');
    process.env.CAREER_OPS_SCAN_HISTORY = path.join(decoy, 'scan-history.tsv');
    try {
      const url = 'https://jobs.example.com/override-check/1';
      expect(await appendOffers(DEFAULT_CODE_ROOT, root, [{ url, company: 'Override Co', title: 'Platform Engineer' }], true)).toEqual({ added: 1, skipped: 0 });
      expect(fs.readdirSync(decoy)).toEqual([]);
      expect(fs.readFileSync(path.join(root, 'data', 'pipeline.md'), 'utf8')).toContain(url);
      expect(fs.readFileSync(path.join(root, 'data', 'scan-history.tsv'), 'utf8')).toContain(url);
    } finally {
      for (const [k, v] of [['CAREER_OPS_PIPELINE', saved.pipeline], ['CAREER_OPS_SCAN_HISTORY', saved.history]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

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
  it('setting a pin revives a retired application by dropping its cleared #N line, which would otherwise outrank the pin (R12-srv-dom-a-L2-03)', () => {
    const text = `${FOLLOWUPS}- cleared #1 2026-10-05 - no contact on file\n- cleared #6 2026-10-05\n`;
    const set = applyFollowupEdit(text, { op: 'pin.set', appNum: 1, date: '2026-10-20', setOn: '2026-10-06' });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.text).not.toMatch(/^- cleared #1 /m);
    expect(set.text).toContain('- cleared #6 2026-10-05');
    expect(set.text).toContain('- next #1 2026-10-20 (set 2026-10-06)');
    // Only a line the cadence reads as a retirement: anything else is the user's text.
    const note = applyFollowupEdit(`${FOLLOWUPS}- cleared #1 2026-10-05x - keep this note\n`, { op: 'pin.set', appNum: 1, date: '2026-10-20', setOn: '2026-10-06' });
    expect(note.ok && note.text).toContain('- cleared #1 2026-10-05x - keep this note');
    const impossible = applyFollowupEdit(`${FOLLOWUPS}- cleared #1 2026-02-31 - note\n`, { op: 'pin.set', appNum: 1, date: '2026-10-20', setOn: '2026-10-06' });
    expect(impossible.ok && impossible.text).toContain('- cleared #1 2026-02-31 - note');
  });
  it('logs into an existing table with other header labels, numbering after every row in the file (R13-feat-a-L2-01)', () => {
    const text = '# Follow-ups\n\n| # | App | Date | Company | Role | Channel | Contact | Notes |\n|---|---|---|---|---|---|---|---|\n| 1 | 3 | 2026-09-01 | Acme | Eng | Email | Pat | asked |\n';
    const r = applyFollowupEdit(text, { op: 'log.add', appNum: 5, date: '2026-10-03', company: 'Globex', role: 'SRE', channel: 'Email', contact: '', notes: '' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.num).toBe(2);
    expect(r.text.match(/^\|---/gm)).toHaveLength(1);
    expect(r.text.split('\n')[5]).toBe('| 2 | 5 | 2026-10-03 | Globex | SRE | Email |  |  |');
  });
  it('logs into the follow-up table, not another table in the file, and counts only follow-up rows (R13-feat-a-L2-01 review)', () => {
    const metrics = '## Stats\n\n| Year | Count |\n|---|---|\n| 2026 | 12 |\n';
    const before = `${metrics}\n# Follow-ups\n\n| # | App | Date | Company | Role | Channel | Contact | Notes |\n|---|---|---|---|---|---|---|---|\n| 1 | 3 | 2026-09-01 | Acme | Eng | Email | Pat | asked |\n\n## Later\n\n| Year | Count |\n|---|---|\n| 2027 | 1 |\n`;
    const r = applyFollowupEdit(before, { op: 'log.add', appNum: 5, date: '2026-10-03', company: 'Globex', role: 'SRE', channel: 'Email', contact: '', notes: '' });
    expect(r.ok && r.num).toBe(2);
    if (!r.ok) return;
    expect(r.text).toContain('| 1 | 3 | 2026-09-01 | Acme | Eng | Email | Pat | asked |\n| 2 | 5 | 2026-10-03 | Globex | SRE | Email |  |  |\n\n## Later');
    expect(applyFollowupEdit(before, { op: 'log.delete', num: 2026 })).toEqual({ ok: false, error: 'not-found' });
  });
  it('refuses to delete a follow-up whose num appears more than once, rather than deleting another application\'s row (R13-feat-a-L2-01)', () => {
    const text = `${FOLLOWUPS}\n| num | appNum | date | company | role | channel | contact | notes |\n|---|---|---|---|---|---|---|---|\n| 1 | 5 | 2026-10-03 | Globex | SRE | Email |  |  |\n`;
    expect(applyFollowupEdit(text, { op: 'log.delete', num: 1 })).toEqual({ ok: false, error: 'ambiguous' });
    const add = applyFollowupEdit(text, { op: 'log.add', appNum: 6, date: '2026-10-04', company: 'V', role: 'R', channel: 'Email', contact: '', notes: '' });
    expect(add.ok && add.num).toBe(3);
  });
  it('rejects dates that are not YYYY-MM-DD', () => {
    expect(applyFollowupEdit(FOLLOWUPS, { op: 'pin.set', appNum: 1, date: 'tomorrow', setOn: '2026-10-03' })).toEqual({ ok: false, error: 'invalid-date' });
  });
});

/** Every action id the spec's section 3.3 table lists. */
export const SPEC_ACTION_IDS = [
  'tracker.setStatus', 'tracker.delete', 'tracker.verify', 'tracker.normalize', 'tracker.dedup', 'tracker.merge', 'tracker.backfillUrls', 'tracker.reconcile', 'tracker.syncCheck', 'tracker.hiredShare', 'tracker.hiredMark',
  // Batch evaluation (3.3 pipeline.batchRun) is the sessions fan-out now: batch-runner.sh's workers run outside any guard.
  'pipeline.prioritize', 'pipeline.rank', 'pipeline.shortlist', 'pipeline.reserveReportNums', 'pipeline.releaseReportNums',
  'scan.portals', 'scan.network', 'scan.full', 'scan.hn', 'scan.interamt', 'scan.funded', 'scan.reposts',
  'portals.validate', 'portals.verify', 'portals.audit', 'portals.fixSlugs',
  'immigration.watch', 'immigration.freshness', 'immigration.h1b',
  // docs.appArtifactsInit is not an action: the pdf mode keys the bundle by the row's own company and role (R8-11).
  'docs.renderPdf', 'docs.coverPdf', 'docs.archivePosting', 'docs.liveness', 'docs.fetchJd', 'docs.prepareApplication', 'docs.imgToPdf',
  'insights.stats', 'insights.funnelVelocity', 'insights.analyzePatterns', 'insights.salaryGap', 'insights.upskill', 'insights.companyHistory', 'insights.rejectionLatency', 'insights.processQuality', 'insights.weeklyDigest', 'insights.assessmentLog', 'insights.keywordMatch', 'insights.jdSkillGap', 'insights.storyProvenance', 'insights.inviteMatch', 'insights.linkedinJoin', 'insights.contacts',
  'followups.seed', 'followups.replyPaste', 'followups.replyWatch', 'followups.inviteMatch', 'followups.contactsVcf', 'followups.linkedinJoin',
  'plugins.list', 'plugins.run', 'plugins.audit',
  'system.doctor', 'system.updateStatus', 'system.updateCheck', 'system.updateApply', 'system.updateDismiss', 'system.rollback',
  'daily.runNow', 'devchat.installDeps',
];

describe('output/ file names the prefill and re-render accept (seed: SW3-web-a-03)', () => {
  const prefill = () => findAction('docs.prepareApplication')!;
  const render = () => findAction('docs.renderPdf')!;
  const url = 'https://boards.greenhouse.io/acme/jobs/1';
  it('accepts names people give the files they drop into output/: spaces, parentheses, accents, an apostrophe', () => {
    for (const pdf of ['output/Acme Resume.pdf', "output/Jane O'Neil CV (2).pdf", 'output/résumé final.PDF', 'output/my folder/cv.pdf', 'output/001-acme/cv/tailored/v001/cv.pdf']) {
      expect(prefill().params.safeParse({ url, pdf }).success, pdf).toBe(true);
    }
    expect(render().params.safeParse({ row: 1, report: 1, html: 'output/Acme Resume.html', pdf: 'output/Acme Resume.pdf' }).success).toBe(true);
  });
  it('still refuses anything that is not a file under output/ with the right extension', () => {
    for (const pdf of ['Acme Resume.pdf', 'output/', 'output//cv.pdf', 'output/../cv.pdf', 'output/a/./cv.pdf', 'output/cv.html', 'output/a\nb.pdf', 'output/a\u0000b.pdf', 'output/a\u0007b.pdf', '/etc/cv.pdf', `output/${'x'.repeat(520)}.pdf`]) {
      expect(prefill().params.safeParse({ url, pdf }).success, JSON.stringify(pdf)).toBe(false);
    }
  });
});

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
      // The numeric form has the text form's six-digit ceiling.
      expect(a.params.safeParse({ report: 999999, ...extra }).success, `${id} 999999`).toBe(true);
      for (const bad of [0, -3, 1.5, '12a', '', 1_000_000, '1000000']) expect(a.params.safeParse({ report: bad, ...extra }).success, `${id} ${JSON.stringify(bad)}`).toBe(false);
    }
    expect(findAction('pipeline.releaseReportNums')!.build({ range: '12-14' }, ctx).args.slice(1)).toEqual(['--release', '12-14']);
    expect(findAction('tracker.merge')!.build({ dryRun: true, verify: true }, ctx).args.slice(1)).toEqual(['--dry-run', '--verify']);
    expect(findAction('tracker.backfillUrls')!.build({ dryRun: false }, ctx).args.slice(1)).toEqual(['--backfill-urls']);
    expect(findAction('immigration.h1b')!.build({ company: 'Acme', mode: 'json' }, ctx).args.slice(1)).toEqual(['Acme', '--json']);
    expect(findAction('followups.replyPaste')!.build({ subject: 's', from: 'f', body: 'b' }, ctx).args).toContain('--file');
    const render = findAction('docs.renderPdf')!.build({ row: 9, report: 1, html: 'output/a.html', pdf: 'output/a.pdf', format: 'a4' }, ctx);
    expect(render.args.slice(1)).toEqual([path.join(ctx.dataRoot, 'output/a.html'), path.join(ctx.dataRoot, 'output/a.pdf'), '--format=a4', '--report=1']);
    // With no format, generate-pdf.mjs takes the profile's page_format; an explicit --format would override it (SW5-web-a-01).
    const unformatted = findAction('docs.renderPdf')!;
    expect(unformatted.build(unformatted.params.parse({ row: 9, report: 1, html: 'output/a.html', pdf: 'output/a.pdf' }), ctx).args.slice(1)).toEqual([path.join(ctx.dataRoot, 'output/a.html'), path.join(ctx.dataRoot, 'output/a.pdf'), '--report=1']);
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
  it('scan.network writes location_filter keys the scanner reads: an allowed location passes, others and a blocked one do not (SW5-tests-13)', async () => {
    const dataRoot = copyFixtureRoot();
    const { buildLocationFilter } = (await import(pathToFileURL(path.join(DEFAULT_CODE_ROOT, 'scan.mjs')).href)) as { buildLocationFilter: (f: unknown) => (location: string, url?: string, title?: string) => boolean };
    const filterFor = (locationAllow: string[], block: string[]) => {
      const cmd = findAction('scan.network')!.build({ roles: [], exclude: [], locationAllow, block, sinceDays: 7, ats: ['greenhouse'], limit: 100 }, { codeRoot: '/code', dataRoot, tmpInputs: [] });
      return buildLocationFilter(YAML.parse(fs.readFileSync(cmd.env!.CAREER_OPS_PORTALS!, 'utf8')).location_filter);
    };
    const remote = filterFor(['Remote'], []);
    expect(remote('Remote - US', 'https://boards.greenhouse.io/acme/jobs/1', 'Backend Engineer')).toBe(true);
    expect(remote('Berlin, Germany', 'https://boards.greenhouse.io/acme/jobs/2', 'Backend Engineer')).toBe(false);
    const blocked = filterFor([], ['Berlin']);
    expect(blocked('Berlin, Germany', 'https://boards.greenhouse.io/acme/jobs/2', 'Backend Engineer')).toBe(false);
    expect(blocked('Austin, TX', 'https://boards.greenhouse.io/acme/jobs/3', 'Backend Engineer')).toBe(true);
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
    'docs.archivePosting': { report: 1, url: 'https://x.example/1' },
    'docs.liveness': { urls: ['https://x.example/1'] },
    'docs.fetchJd': { url: 'https://x.example/1' },
    'docs.prepareApplication': { url: 'https://x.example/1', pdf: 'output/a.pdf' },
    'docs.imgToPdf': { file: 'output/a.png', pdf: 'output/a.pdf' },
    'insights.keywordMatch': { report: 1 },
    'followups.seed': { appNum: 1 },
    'followups.replyPaste': { subject: 's', from: 'f', body: 'b' },
    'followups.inviteMatch': { text: 'hello' },
    'insights.inviteMatch': { text: 'hello' },
    'insights.jdSkillGap': { text: '- Experience with Python' },
    'projects.rank': { text: 'We need Python.' },
    'followups.contactsVcf': { callerId: true },
    'plugins.run': { id: 'h1b-sponsor', hook: 'check', args: [] },
    'system.updateDismiss': { version: '1.2.3' },
  };
  return samples[id] ?? {};
}

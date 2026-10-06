// Actions only Cmd+K runs (R8-11): each one must hand its script the argv that script really parses. Every test runs
// the real script (or, for the network-bound portal audit, the script's own baseline reader) on a fixture data root.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { findAction } from '../../server/actions/registry.js';
import { RunStore } from '../../server/runner/store.js';
import type { RunMeta } from '../../server/runner/store.js';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { tempDir } from '../helpers/tmp.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

const post = (id: string, params: Record<string, unknown>) => t.app.inject({ method: 'POST', url: `/api/actions/${id}`, headers: t.authedWrite, payload: { params } });
const get = (url: string) => t.app.inject({ method: 'GET', url, headers: t.authed });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function finished(runId: string): Promise<{ meta: RunMeta; text: string }> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const body = (await get(`/api/runs/${runId}`)).json() as { meta: RunMeta; lines: Array<{ line: string }> };
    if (!['queued', 'running'].includes(body.meta.status)) return { meta: body.meta, text: body.lines.map((l) => l.line).join('\n') };
    if (Date.now() > deadline) throw new Error(`run ${runId} still ${body.meta.status}`);
    await wait(100);
  }
}

describe('Keyword match', () => {
  it('reads the numbered report from reports/, not a file named by the number in the code checkout', async () => {
    // Report 001 is in the full oferta layout, its Keywords extracted block included (SW5-tests-12).
    const res = await post('insights.keywordMatch', { report: 1 });
    expect(res.statusCode, res.body).toBe(200);
    const result = res.json().result as { total?: number; matched?: unknown[]; missing?: unknown[] };
    expect(result).toMatchObject({ total: 15 });
  });

  it('asks for a report that has a file, before running', async () => {
    expect((await post('insights.keywordMatch', {})).statusCode).toBe(400);
    const res = await post('insights.keywordMatch', { report: 99 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/report 99/i);
  });

  it("says why when the report has no keywords block, in the script's own words", async () => {
    const res = await post('insights.keywordMatch', { report: 3 });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/No "## Keywords extracted" block/);
  });
});

describe('Reply watch digest (SW-server-02)', () => {
  const candidates = () => path.join(t.cfg.dataRoot, 'data', 'reply-candidates.json');

  it('with no pasted replies yet, refuses before running, so reply-watch.mjs never seeds its mock emails into the data root', async () => {
    fs.rmSync(candidates(), { force: true });
    const res = await post('followups.replyWatch', {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/No replies to review yet.*Paste a reply/);
    expect(fs.existsSync(candidates())).toBe(false);
  });

  it('with a pasted reply, digests only that reply and leaves the candidates file as it was', async () => {
    const pasted = [{ message_id: 'paste-1', from: 'talent@acme.example', subject: 'Next steps', body_snippet: 'Thanks for applying, we will be in touch.', signal: null }];
    fs.writeFileSync(candidates(), JSON.stringify(pasted, null, 2));
    try {
      const res = await post('followups.replyWatch', {});
      expect(res.statusCode, res.body).toBe(202);
      const { meta, text } = await finished(res.json().runId);
      expect(meta.status, text).toBe('done');
      expect(text).toMatch(/Today: 1 application updates need review/);
      expect(text).not.toMatch(/wingyun|zhaopin|mock candidates/i);
      expect(JSON.parse(fs.readFileSync(candidates(), 'utf8'))).toEqual(pasted);
    } finally {
      fs.rmSync(candidates(), { force: true });
    }
  });
});

describe('Reply watch digest: a file holding only the mock emails is no replies (SW7-web-a-02 review)', () => {
  const candidates = () => path.join(t.cfg.dataRoot, 'data', 'reply-candidates.json');
  /** What a direct `node reply-watch.mjs` run leaves behind when the file is missing: its own mock emails. */
  const seedMocks = () => {
    fs.rmSync(candidates(), { force: true });
    try {
      execFileSync(process.execPath, [path.join(DEFAULT_CODE_ROOT, 'reply-watch.mjs')], { cwd: DEFAULT_CODE_ROOT, env: { ...process.env, CAREER_OPS_ROOT: t.cfg.dataRoot, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
    } catch {
      // The digest may exit non-zero on the fixture; the seeding happens first either way.
    }
    expect(JSON.parse(fs.readFileSync(candidates(), 'utf8')).length).toBeGreaterThan(0);
  };

  it('refuses the digest when every entry is one of the mocks reply-watch.mjs seeds', async () => {
    seedMocks();
    try {
      const res = await post('followups.replyWatch', {});
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/No replies to review yet.*Paste a reply/);
    } finally {
      fs.rmSync(candidates(), { force: true });
    }
  });

  it('refuses the digest when the file is an empty list, which no paste leaves behind (review fix 2)', async () => {
    fs.writeFileSync(candidates(), '[]\n');
    try {
      const res = await post('followups.replyWatch', {});
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/No replies to review yet.*Paste a reply/);
    } finally {
      fs.rmSync(candidates(), { force: true });
    }
  });

  it('refuses the digest, naming the file, when the file is not a JSON list (review fix 3)', async () => {
    for (const content of ['{}\n', 'not-json\n']) {
      fs.writeFileSync(candidates(), content);
      try {
        const res = await post('followups.replyWatch', {});
        expect(res.statusCode, content).toBe(400);
        expect(res.json().error, content).toMatch(/data\/reply-candidates\.json is not a JSON list of replies/);
      } finally {
        fs.rmSync(candidates(), { force: true });
      }
    }
  });

  it('runs once a real reply was pasted next to the mocks', async () => {
    seedMocks();
    const seeded = JSON.parse(fs.readFileSync(candidates(), 'utf8')) as unknown[];
    fs.writeFileSync(candidates(), JSON.stringify([...seeded, { message_id: 'paste-1', from: 'talent@acme.example', subject: 'Next steps', body_snippet: 'Thanks for applying.', signal: null }], null, 2));
    try {
      const res = await post('followups.replyWatch', {});
      expect(res.statusCode, res.body).toBe(202);
      await finished(res.json().runId);
    } finally {
      fs.rmSync(candidates(), { force: true });
    }
  });
});

describe('Merge tracker additions and Backfill tracker URLs (SW-server-06)', () => {
  it('merge never passes --backfill-urls, which makes merge-tracker.mjs backfill and exit before merging', () => {
    const merge = findAction('tracker.merge')!;
    const ctx = { codeRoot: DEFAULT_CODE_ROOT, dataRoot: t.cfg.dataRoot, claudeBin: t.cfg.claudeBin, tmpInputs: [] };
    expect(merge.build(merge.params.parse({ dryRun: false, verify: true, backfillUrls: true }), ctx).args.slice(1)).toEqual(['--verify']);
  });

  it('the URL backfill is its own action that runs the script\'s backfill', async () => {
    const res = await post('tracker.backfillUrls', { dryRun: true });
    expect(res.statusCode, res.body).toBe(202);
    const { meta, text } = await finished(res.json().runId);
    expect(meta.status, text).toBe('done');
    expect(meta.cmd.args.slice(1)).toEqual(['--backfill-urls', '--dry-run']);
    expect(text).toMatch(/Backfill URLs \(dry-run\)/);
  });
});

describe('Seed follow-up cadence', () => {
  it('seeds one application by number, or backfills every one, and refuses neither or both', async () => {
    const one = await post('followups.seed', { appNum: 1, dryRun: true });
    expect(one.statusCode, one.body).toBe(202);
    const a = await finished(one.json().runId);
    expect(a.meta.status, a.text).toBe('done');
    expect(a.text).toMatch(/"appNum": ?1/);
    const all = await post('followups.seed', { backfill: true, dryRun: true });
    expect(all.statusCode, all.body).toBe(202);
    const b = await finished(all.json().runId);
    expect(b.meta.status, b.text).toBe('done');
    expect(b.text).not.toMatch(/Usage/);
    expect((await post('followups.seed', {})).statusCode).toBe(400);
    expect((await post('followups.seed', { appNum: 1, backfill: true })).statusCode).toBe(400);
  });
});

describe('Image to PDF', () => {
  // A 1x1 PNG.
  const raw = Buffer.from([0, 255, 0, 0]);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);

  it('converts an image under output/ into the PDF named under output/', async () => {
    fs.writeFileSync(path.join(t.cfg.dataRoot, 'output', 'offer-shot.png'), png);
    const res = await post('docs.imgToPdf', { file: 'output/offer-shot.png', pdf: 'output/offer-shot.pdf' });
    expect(res.statusCode, res.body).toBe(202);
    const run = await finished(res.json().runId);
    expect(run.meta.status, run.text).toBe('done');
    expect(fs.readFileSync(path.join(t.cfg.dataRoot, 'output', 'offer-shot.pdf')).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('refuses a PDF path that leads outside output/ through a symlinked file or folder, and leaves the outside file alone (SW3-tests-03)', async () => {
    fs.writeFileSync(path.join(t.cfg.dataRoot, 'output', 'shot2.png'), png);
    const outside = tempDir('cc-img-outside-');
    fs.writeFileSync(path.join(outside, 'victim.pdf'), 'keep me');
    fs.symlinkSync(path.join(outside, 'victim.pdf'), path.join(t.cfg.dataRoot, 'output', 'linked.pdf'));
    fs.symlinkSync(outside, path.join(t.cfg.dataRoot, 'output', 'linked-dir'));
    try {
      const file = await post('docs.imgToPdf', { file: 'output/shot2.png', pdf: 'output/linked.pdf', force: true });
      expect(file.statusCode, file.body).toBe(400);
      expect(file.body).toMatch(/outside/);
      const dir = await post('docs.imgToPdf', { file: 'output/shot2.png', pdf: 'output/linked-dir/new.pdf', force: true });
      expect(dir.statusCode, dir.body).toBe(400);
      expect(fs.readFileSync(path.join(outside, 'victim.pdf'), 'utf8')).toBe('keep me');
      expect(fs.existsSync(path.join(outside, 'new.pdf'))).toBe(false);
    } finally {
      fs.rmSync(path.join(t.cfg.dataRoot, 'output', 'linked.pdf'));
      fs.rmSync(path.join(t.cfg.dataRoot, 'output', 'linked-dir'));
    }
  });

  it('refuses a missing image, or an output that is not a PDF, before running', async () => {
    expect((await post('docs.imgToPdf', { file: 'output/nope.png', pdf: 'output/x.pdf' })).statusCode).toBe(400);
    expect((await post('docs.imgToPdf', { file: 'output/acme-robotics-cv.html', pdf: 'output/x.txt' })).statusCode).toBe(400);
  });
});

describe('Archive posting', () => {
  it('takes a report number, never the row number "n" means elsewhere, and refuses one with no report file (SW4-libs-03)', async () => {
    const action = findAction('docs.archivePosting')!;
    expect(action.params.safeParse({ n: 1, url: 'https://jobs.example.com/1' }).success).toBe(false);
    expect(action.params.safeParse({ report: 1, url: 'https://jobs.example.com/1' }).success).toBe(true);
    const missing = await post('docs.archivePosting', { report: 99, url: 'https://jobs.example.com/1' });
    expect(missing.statusCode, missing.body).toBe(400);
    expect(missing.body).toMatch(/no file for report 99 under reports\//);
  });
});

describe('Paste a reply', () => {
  it('appends one reply candidate per paste to data/reply-candidates.json, with the pasted sender, subject and body (SW3-tests-17)', async () => {
    const file = path.join(t.cfg.dataRoot, 'data', 'reply-candidates.json');
    fs.rmSync(file, { force: true });
    const first = await post('followups.replyPaste', { from: 'Dana Recruiter <dana@acme.example>', subject: 'Re: Platform Engineer', body: 'Thanks for applying.\n\nCan you talk Tuesday?' });
    expect(first.statusCode, first.body).toBe(200);
    // A body that itself starts with header-like lines, and a sender with a line break, stay in their fields.
    const second = await post('followups.replyPaste', { from: 'Lee\nOps', subject: '', body: 'Subject: not a header\nFrom: nobody' });
    expect(second.statusCode, second.body).toBe(200);
    const candidates = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
    expect(candidates.map(({ from, subject, body_snippet }) => ({ from, subject, body_snippet }))).toEqual([
      { from: 'Dana Recruiter <dana@acme.example>', subject: 'Re: Platform Engineer', body_snippet: 'Thanks for applying.\n\nCan you talk Tuesday?' },
      { from: 'Lee Ops', subject: '', body_snippet: 'Subject: not a header\nFrom: nobody' },
    ]);
    expect(new Set(candidates.map((c) => c.message_id)).size).toBe(2);
  });
});

describe('checks that ran and found something (server-7 minor wording)', () => {
  it('Tracker sync check on a tracker with a problem answers 200 with the findings and its output, not a failure', async () => {
    const file = path.join(t.cfg.dataRoot, 'data', 'applications.md');
    const before = fs.readFileSync(file, 'utf8');
    try {
      fs.appendFileSync(file, '| 9 | 2026-10-01 | Bad Row | Engineer | 4.0/5 | NotAState | ❌ | - | x |\n');
      const res = await post('tracker.syncCheck', {});
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().findings).toMatch(/found problems/);
      expect(res.json().stderr).toContain('Corruption detected');
    } finally {
      fs.writeFileSync(file, before);
    }
    const clean = await post('tracker.syncCheck', {});
    expect(clean.statusCode).toBe(200);
    expect(clean.json().findings).toBeUndefined();
  });

  it('Dismiss update refuses a version that is not X.Y.Z before running, as update-system.mjs would', () => {
    const action = findAction('system.updateDismiss')!;
    expect(action.params.safeParse({ version: '1.2.3' }).success).toBe(true);
    expect(action.params.safeParse({ version: 'v1.2.3' }).success).toBe(true);
    for (const version of ['latest', '1.2', '1.2.3-beta']) expect(action.params.safeParse({ version }).success, version).toBe(false);
  });
});

describe('Recently funded companies', () => {
  it('offers exactly the sorts company-funded.mjs accepts', () => {
    const source = fs.readFileSync(path.join(DEFAULT_CODE_ROOT, 'company-funded.mjs'), 'utf8');
    const accepted = JSON.parse(source.match(/if \(!(\[[^\]]+\])\.includes\(opts\.sort\)\)/)![1]!.replace(/'/g, '"')) as string[];
    const action = findAction('scan.funded')!;
    for (const sort of accepted) expect(action.params.safeParse({ sort }).success, sort).toBe(true);
    for (const sort of ['amount', 'name']) expect(action.params.safeParse({ sort }).success, sort).toBe(false);
  });
});

describe('Release report numbers', () => {
  it('takes one number or one range, as reserve-report-num.mjs --release does, and releases it', async () => {
    const reserved = await post('pipeline.reserveReportNums', { count: 2 });
    expect(reserved.statusCode, reserved.body).toBe(200);
    const range = String(reserved.json().result).match(/(\d+)(?:\s*-\s*(\d+))?/)!;
    const nums = [Number(range[1]), Number(range[2] ?? range[1])];
    // The reservation is its reports/NNN-RESERVED.md sentinels; the release must remove exactly those (SW3-tests-18).
    const sentinels = () => fs.readdirSync(path.join(t.cfg.dataRoot, 'reports')).filter((f) => /^\d+-RESERVED\.md$/.test(f) && nums.includes(parseInt(f, 10)));
    expect(sentinels()).toHaveLength(2);
    const res = await post('pipeline.releaseReportNums', { range: `${range[1]}-${range[2] ?? range[1]}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(sentinels()).toEqual([]);
    // A sentinel outside the released range stays.
    expect(fs.existsSync(path.join(t.cfg.dataRoot, 'reports', '005-RESERVED.md'))).toBe(true);
    expect((await post('pipeline.releaseReportNums', { range: '8,9' })).statusCode).toBe(400);
  });
});

describe('Audit portals against an earlier audit', () => {
  // audit-portals.mjs --json pretty-prints its rows over many stdout lines; the run log keeps one NDJSON event per line.
  function earlierAudit(rows: unknown, actionId = 'portals.audit'): string {
    const store = new RunStore(t.cfg.dataRoot);
    const meta = store.create({ actionId, label: 'Audit portals', cost: 'network', resources: [], claude: false, cmd: { bin: 'node', args: [], cwd: DEFAULT_CODE_ROOT }, params: {} });
    store.write({ ...meta, status: 'done', exitCode: 0 });
    const lines = JSON.stringify(rows, null, 2).split('\n');
    fs.writeFileSync(path.join(store.dirOf(meta.id), 'raw.ndjson'), lines.map((line, i) => JSON.stringify({ seq: i + 1, ts: '2026-10-05T12:00:00.000Z', stream: 'stdout', line })).join('\n') + '\n');
    return meta.id;
  }

  it("passes that run's JSON output as the baseline, which the script's own reader turns into drops", async () => {
    const id = earlierAudit([{ name: 'Acme Robotics', provider: 'greenhouse', verdict: 'ok', count: 40 }]);
    const started: Array<{ cmd: { args: string[] }; tmpInputs?: string[] }> = [];
    // Captured, not run: the audit itself fetches every board.
    const spy = vi.spyOn(t.runner, 'start').mockImplementation((req) => {
      started.push(req);
      return { id: '20261005000000-abcdef' } as RunMeta;
    });
    try {
      const res = await post('portals.audit', { baselineRunId: id });
      expect(res.statusCode, res.body).toBe(202);
    } finally {
      spy.mockRestore();
    }
    const args = started[0]!.cmd.args;
    const baseline = args[args.indexOf('--baseline') + 1]!;
    expect(started[0]!.tmpInputs).toContain(baseline);
    const prev = JSON.parse(fs.readFileSync(baseline, 'utf8'));
    fs.rmSync(baseline);
    const audit = (await import(pathToFileURL(path.join(DEFAULT_CODE_ROOT, 'audit-portals.mjs')).href)) as { diffAgainstBaseline: (current: unknown[], baseline: unknown[]) => unknown[] };
    // As audit-portals.mjs reads a baseline file: an array of rows, or { rows, drops }.
    const drops = audit.diffAgainstBaseline([{ name: 'Acme Robotics', count: 4 }], Array.isArray(prev) ? prev : prev.rows);
    expect(drops).toEqual([{ name: 'Acme Robotics', before: 40, after: 4, lost: 36 }]);
  });

  it('refuses a run that is not a finished portal audit, before running', async () => {
    const other = earlierAudit([], 'pipeline.prioritize');
    expect((await post('portals.audit', { baselineRunId: other })).statusCode).toBe(400);
    expect((await post('portals.audit', { baselineRunId: '20200101000000-000000' })).statusCode).toBe(400);
  });
});

describe('Initialize application artifacts', () => {
  it('is not a palette action: the pdf mode makes the bundle from the row it tailors', () => {
    expect(findAction('docs.appArtifactsInit')).toBeUndefined();
  });
});

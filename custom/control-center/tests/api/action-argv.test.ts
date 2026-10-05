// Actions only Cmd+K runs (R8-11): each one must hand its script the argv that script really parses. Every test runs
// the real script (or, for the network-bound portal audit, the script's own baseline reader) on a fixture data root.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { findAction } from '../../server/actions/registry.js';
import { RunStore } from '../../server/runner/store.js';
import type { RunMeta } from '../../server/runner/store.js';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';

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
    const report = path.join(t.cfg.dataRoot, 'reports', '001-acme-robotics.md');
    fs.appendFileSync(report, '\n## Keywords extracted\n\n- Python, Kafka, Kubernetes\n');
    const res = await post('insights.keywordMatch', { report: 1 });
    expect(res.statusCode, res.body).toBe(200);
    const result = res.json().result as { total?: number; matched?: unknown[]; missing?: unknown[] };
    expect(result).toMatchObject({ total: 3 });
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
  it('converts an image under output/ into the PDF named under output/', async () => {
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
    fs.writeFileSync(path.join(t.cfg.dataRoot, 'output', 'offer-shot.png'), png);
    const res = await post('docs.imgToPdf', { file: 'output/offer-shot.png', pdf: 'output/offer-shot.pdf' });
    expect(res.statusCode, res.body).toBe(202);
    const run = await finished(res.json().runId);
    expect(run.meta.status, run.text).toBe('done');
    expect(fs.readFileSync(path.join(t.cfg.dataRoot, 'output', 'offer-shot.pdf')).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('refuses a missing image, or an output that is not a PDF, before running', async () => {
    expect((await post('docs.imgToPdf', { file: 'output/nope.png', pdf: 'output/x.pdf' })).statusCode).toBe(400);
    expect((await post('docs.imgToPdf', { file: 'output/acme-robotics-cv.html', pdf: 'output/x.txt' })).statusCode).toBe(400);
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
    const res = await post('pipeline.releaseReportNums', { range: `${range[1]}-${range[2] ?? range[1]}` });
    expect(res.statusCode, res.body).toBe(200);
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

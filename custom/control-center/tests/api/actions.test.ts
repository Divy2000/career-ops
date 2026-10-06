import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { copyFixtureRoot, makeTestApp, PACKAGE_ROOT, type TestApp } from '../helpers/app.js';
import { DailyJobWatch } from '../../server/system/daily.js';
import { pinnedNodeBin } from '../../server/system/schedule.js';
import { execNoShell, type Exec } from '../../server/routes/system.js';
import { tempDir } from '../helpers/tmp.js';
import type { RunMeta } from '../../server/runner/store.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

const post = (url: string, payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url, headers: t.authedWrite, payload });
const get = (url: string) => t.app.inject({ method: 'GET', url, headers: t.authed });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForRun(id: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const meta = (await get(`/api/runs/${id}`)).json().meta;
    if (!['queued', 'running'].includes(meta.status)) return meta;
    if (Date.now() > deadline) throw new Error(`run ${id} still ${meta.status}`);
    await wait(100);
  }
}

describe('action registry', () => {
  it('lists actions with cost, resources and a JSON schema for params', async () => {
    const res = await get('/api/actions');
    expect(res.statusCode).toBe(200);
    const setStatus = res.json().find((a: { id: string }) => a.id === 'tracker.setStatus');
    expect(setStatus).toMatchObject({ cost: 'free', resources: ['tracker'], sync: true });
    expect(setStatus.params.properties.state.enum).toContain('Applied');
    expect(res.json().find((a: { id: string }) => a.id === 'daily.runNow').confirm).toMatch(/Continue/);
  });

  it('rejects unknown actions and invalid params before anything runs', async () => {
    expect((await post('/api/actions/nope', { params: {} })).statusCode).toBe(404);
    const bad = await post('/api/actions/tracker.setStatus', { params: { row: 'x', state: 'Nope' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues.length).toBeGreaterThan(0);
  });

  it('tracker.setStatus runs the core CLI with --source web and appends to status-log', async () => {
    const res = await post('/api/actions/tracker.setStatus', { params: { row: 2, state: 'Applied' } });
    expect(res.statusCode, res.body).toBe(200);
    const tracker = (await get('/api/tracker')).json();
    expect(tracker.rows.find((r: { num: number }) => r.num === 2).status).toBe('Applied');
    const log = fs.readFileSync(path.join(t.cfg.dataRoot, 'data', 'status-log.tsv'), 'utf8').trim().split('\n');
    expect(log.at(-1)).toMatch(/^2\t\d{4}-\d{2}-\d{2}\tEvaluated\tApplied\tweb/);
  });

  it('deletes the input file a sync action wrote (pasted text) once the run returns, success or failure', async () => {
    const tmp = path.join(t.cfg.dataRoot, 'data', 'control-center', 'tmp');
    const left = () => (fs.existsSync(tmp) ? fs.readdirSync(tmp) : []);
    const ok = await post('/api/actions/projects.rank', { params: { text: 'We need Python and Kafka experience.' } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(left()).toEqual([]);
    const library = path.join(t.cfg.dataRoot, 'article-digest.md');
    const before = fs.readFileSync(library, 'utf8');
    fs.writeFileSync(library, '## Empty\nTags: go\n');
    try {
      const failing = await post('/api/actions/projects.rank', { params: { text: 'Python.' } });
      expect(failing.statusCode).toBe(422);
      expect(left()).toEqual([]);
    } finally {
      fs.writeFileSync(library, before);
    }
  });

  it('Match invite runs invite-match.mjs with flags it accepts and returns its JSON verdict, from Insights and from Follow-ups', async () => {
    for (const id of ['insights.inviteMatch', 'followups.inviteMatch']) {
      const res = await post(`/api/actions/${id}`, { params: { text: 'Hi, this is Jordan from Example Corp. Can we schedule an interview for the backend role?' } });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().result).toMatchObject({ classification: expect.any(String), candidates: expect.any(Array) });
    }
  });

  it('maps set-status exit codes to HTTP statuses', async () => {
    const missing = await post('/api/actions/tracker.setStatus', { params: { row: 99, state: 'Applied' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().exit).toBe(2);
  });

  it('system.doctor returns the JSON report synchronously', async () => {
    const res = await post('/api/actions/system.doctor', { params: {} });
    // doctor.mjs --json reports its findings in the JSON and always exits 0.
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().result).toBeTypeOf('object');
  });

  it('an async action returns a run id, the run finishes and its log is readable', async () => {
    const res = await post('/api/actions/pipeline.prioritize', { params: {} });
    expect(res.statusCode).toBe(202);
    const { runId } = res.json();
    const meta = await waitForRun(runId);
    expect(meta).toMatchObject({ actionId: 'pipeline.prioritize', status: 'done', exitCode: 0 });
    const detail = (await get(`/api/runs/${runId}`)).json();
    expect(Array.isArray(detail.lines)).toBe(true);
    const list = (await get('/api/runs')).json();
    expect(list.map((r: { id: string }) => r.id)).toContain(runId);
    expect((await get('/api/runs/does-not-exist')).statusCode).toBe(404);
  });

  it('a stray file in the runs folder (Finder\'s .DS_Store) neither stops the app starting nor breaks the runs list and async actions (SW-server-01)', async () => {
    const dataRoot = copyFixtureRoot();
    const runs = path.join(dataRoot, 'data', 'control-center', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(path.join(runs, '.DS_Store'), 'finder');
    fs.writeFileSync(path.join(runs, 'notes'), 'a file, not a run');
    const stray = await makeTestApp({ dataRoot });
    try {
      const list = await stray.app.inject({ method: 'GET', url: '/api/runs', headers: stray.authed });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json()).toEqual([]);
      const res = await stray.app.inject({ method: 'POST', url: '/api/actions/pipeline.prioritize', headers: stray.authedWrite, payload: { params: {} } });
      expect(res.statusCode, res.body).toBe(202);
    } finally {
      await stray.close();
    }
  });

  it('Audit plugins runs the community plugin audit to the end instead of exiting with the usage text (R8-04)', async () => {
    const res = await post('/api/actions/plugins.audit', { params: {} });
    expect(res.statusCode, res.body).toBe(202);
    const meta = await waitForRun(res.json().runId);
    const lines = ((await get(`/api/runs/${res.json().runId}`)).json().lines as Array<{ line: string }>).map((l) => l.line).join('\n');
    expect(lines).not.toMatch(/Usage:/);
    expect(meta, lines).toMatchObject({ actionId: 'plugins.audit', status: 'done', exitCode: 0 });
    // The test app's plugins.local/ is an empty temp folder, never the developer's own.
    expect(lines).toMatch(/No community plugins in plugins\.local\//);
  });

  it('Audit plugins audits the plugins.local/ the app is configured with, and a flagged plugin fails the run with its finding (SW2-tests-11)', async () => {
    const local = tempDir('cc-plugins-local-');
    fs.mkdirSync(path.join(local, 'sneaky'));
    fs.writeFileSync(path.join(local, 'sneaky', 'manifest.json'), JSON.stringify({ id: 'sneaky', name: 'sneaky', version: '1.0.0', hooks: ['check'] }));
    fs.writeFileSync(path.join(local, 'sneaky', 'index.mjs'), `import { exec } from 'node:${'child'}_process';\nexport const hooks = { check: () => exec };\n`);
    const own = await makeTestApp({ pluginsLocalDir: local });
    try {
      const res = await own.app.inject({ method: 'POST', url: '/api/actions/plugins.audit', headers: own.authedWrite, payload: { params: {} } });
      expect(res.statusCode, res.body).toBe(202);
      const id = res.json().runId as string;
      let meta: RunMeta;
      for (;;) {
        meta = (await own.app.inject({ method: 'GET', url: `/api/runs/${id}`, headers: own.authed })).json().meta;
        if (!['queued', 'running'].includes(meta.status)) break;
        await wait(100);
      }
      const lines = ((await own.app.inject({ method: 'GET', url: `/api/runs/${id}`, headers: own.authed })).json().lines as Array<{ line: string }>).map((l) => l.line).join('\n');
      expect(meta, lines).toMatchObject({ status: 'failed', exitCode: 1 });
      expect(lines).toMatch(/✗ sneaky\/index\.mjs: forbidden import "node:child_process"/);
    } finally {
      await own.close();
    }
  });

  it('JD skill gap runs jd-skill-gap.mjs on the pasted JD and finishes, and asks for the JD instead of running without one (R7-15)', async () => {
    expect((await post('/api/actions/insights.jdSkillGap', { params: {} })).statusCode).toBe(400);
    const res = await post('/api/actions/insights.jdSkillGap', { params: { text: '## Requirements\n\n- 5+ years of experience with Python\n- Experience with Kafka and Kubernetes\n' } });
    expect(res.statusCode, res.body).toBe(202);
    const meta = await waitForRun(res.json().runId);
    expect(meta).toMatchObject({ actionId: 'insights.jdSkillGap', status: 'done', exitCode: 0 });
    const lines = ((await get(`/api/runs/${res.json().runId}`)).json().lines as Array<{ line: string }>).map((l) => l.line).join('\n');
    expect(lines).not.toMatch(/Usage: node jd-skill-gap\.mjs/);
    expect(lines).toMatch(/JD skills found: 3/);
    expect(lines).toMatch(/Real gaps \(not found anywhere\): Kafka, Kubernetes/);
  });

  it('an async action records the input files it wrote with its run, the network scan filters file passed only in the env included', async () => {
    const started: Array<Parameters<typeof t.runner.start>[0]> = [];
    // Captured, not run: the network scan would fetch the public ATS dataset.
    const spy = vi.spyOn(t.runner, 'start').mockImplementation((req) => {
      started.push(req);
      return { id: '20261005000000-abcdef' } as RunMeta;
    });
    try {
      const res = await post('/api/actions/scan.network', { params: { roles: ['backend'], ats: ['greenhouse'] } });
      expect(res.statusCode, res.body).toBe(202);
      const filters = started[0]!.env!.CAREER_OPS_PORTALS!;
      expect(started[0]!.cmd.args).not.toContain(filters);
      expect(started[0]!.tmpInputs).toEqual([filters]);
      fs.rmSync(filters);
    } finally {
      spy.mockRestore();
    }
  });

  it('the network scan refuses an ATS source the scanner has no directory for before anything runs, and takes the ones it has', async () => {
    const started: Array<Parameters<typeof t.runner.start>[0]> = [];
    const spy = vi.spyOn(t.runner, 'start').mockImplementation((req) => {
      started.push(req);
      return { id: '20261005000000-abcdef' } as RunMeta;
    });
    try {
      for (const ats of ['workable', 'smartrecruiters', 'recruitee', 'personio']) {
        const res = await post('/api/actions/scan.network', { params: { roles: ['backend'], ats: ['greenhouse', ats] } });
        expect(res.statusCode, `${ats}: ${res.body}`).toBe(400);
      }
      expect(started).toEqual([]);
      const ok = await post('/api/actions/scan.network', { params: { roles: ['backend'], ats: ['workday', 'icims'] } });
      expect(ok.statusCode, ok.body).toBe(202);
      expect(started[0]!.cmd.args.join(' ')).toContain('--ats workday,icims');
      for (const req of started) for (const f of req.tmpInputs ?? []) fs.rmSync(f, { force: true });
    } finally {
      spy.mockRestore();
    }
  });

  it('Run the daily job now runs the claude the app runs: its absolute path reaches run-daily.sh as CC_CLAUDE_BIN', async () => {
    const started: Array<Parameters<typeof t.runner.start>[0]> = [];
    // Captured, not run: the daily job would scan portals and call Claude.
    const spy = vi.spyOn(t.runner, 'start').mockImplementation((req) => {
      started.push(req);
      return { id: '20261005000000-abcdef' } as RunMeta;
    });
    try {
      const res = await post('/api/actions/daily.runNow', { params: {}, confirmed: true });
      expect(res.statusCode, res.body).toBe(202);
      expect(path.isAbsolute(t.cfg.claudeBin)).toBe(true);
      expect(started[0]!.cmd.args).toEqual([path.join(t.cfg.codeRoot, 'custom/immigration/run-daily.sh')]);
      expect(started[0]!.env).toMatchObject({ CC_CLAUDE_BIN: t.cfg.claudeBin, CAREER_OPS_ROOT: t.cfg.dataRoot });
    } finally {
      spy.mockRestore();
    }
  });

  it('an action marked confirm runs only with the explicit confirmation, and a dry-run preview needs none (seed: server-side confirm)', async () => {
    const started: Array<Parameters<typeof t.runner.start>[0]> = [];
    const spy = vi.spyOn(t.runner, 'start').mockImplementation((req) => {
      started.push(req);
      return { id: '20261005000000-abcdef' } as RunMeta;
    });
    try {
      for (const [id, params] of [['daily.runNow', {}], ['system.rollback', {}], ['system.updateApply', {}], ['devchat.installDeps', {}], ['portals.fixSlugs', { apply: true }]] as const) {
        const res = await post(`/api/actions/${id}`, { params });
        expect(res.statusCode, `${id}: ${res.body}`).toBe(428);
        expect(res.json().confirm, id).toBeTypeOf('string');
        expect((await post(`/api/actions/${id}`, { params, confirmed: 'yes' })).statusCode, `${id} with a non-boolean flag`).toBe(428);
      }
      expect(started).toEqual([]);
      // The fix-slugs dry run only previews: no confirmation.
      expect((await post('/api/actions/portals.fixSlugs', { params: { apply: false } })).statusCode).toBe(202);
      expect((await post('/api/actions/daily.runNow', { params: {}, confirmed: true })).statusCode).toBe(202);
      expect(started.map((r) => r.actionId)).toEqual(['portals.fixSlugs', 'daily.runNow']);
    } finally {
      spy.mockRestore();
    }
  });

  it('Run the daily job now while the daily job is already running is refused as skipped, and starts nothing (SW4-server-01)', async () => {
    const busy = await makeTestApp({ fakeDaily: 'running' });
    // Captured, not run, should the refusal fail: the daily job would scan portals and call Claude.
    const spy = vi.spyOn(busy.runner, 'start').mockImplementation(() => ({ id: '20261005000000-abcdef' }) as RunMeta);
    try {
      const res = await busy.app.inject({ method: 'POST', url: '/api/actions/daily.runNow', headers: busy.authedWrite, payload: { params: {}, confirmed: true } });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toMatch(/^Skipped: the daily job is already running/);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await busy.close();
    }
  });

  it('Run the daily job now while this app\'s own daily run is still queued is refused, and only one daily run is queued (SW6-server-03)', async () => {
    const app = await makeTestApp();
    // A scan holds the pipeline resource, so the first daily run waits behind it, with no pidfile yet.
    const blocker = app.runner.start({ actionId: 'test.noisy', label: 'noisy', cost: 'free', resources: ['pipeline'], claude: false, params: {}, cmd: { bin: process.execPath, args: [path.join(PACKAGE_ROOT, 'tests', 'fakes', 'noisy.mjs'), '0', '20000'], cwd: PACKAGE_ROOT } });
    const run = () => app.app.inject({ method: 'POST', url: '/api/actions/daily.runNow', headers: app.authedWrite, payload: { params: {}, confirmed: true } });
    let first: string | undefined;
    try {
      const a = await run();
      expect(a.statusCode, a.body).toBe(202);
      first = a.json().runId as string;
      expect(app.runner.queuedIds()).toContain(first);
      const b = await run();
      expect(b.statusCode, b.body).toBe(409);
      expect(b.json().error).toMatch(/^Skipped: the daily job is already queued/);
      expect(b.json().error).toContain(first);
      expect(app.runner.queuedIds().filter((id) => app.runner.store.read(id)?.actionId === 'daily.runNow')).toEqual([first]);
    } finally {
      if (first) app.runner.cancel(first);
      app.runner.cancel(blocker.id);
      for (let i = 0; i < 200 && !app.runner.store.readExit(blocker.id); i++) await new Promise((r) => setTimeout(r, 50));
      await app.close();
    }
  });

  it('two Run the daily job now requests at once queue one daily run: the other is refused with 409, however slow the job probe is (SW6-server-03 review)', async () => {
    const app = await makeTestApp();
    const slowProbe = vi.spyOn(DailyJobWatch.prototype, 'runningNow').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 150));
      return false;
    });
    const blocker = app.runner.start({ actionId: 'test.noisy', label: 'noisy', cost: 'free', resources: ['pipeline'], claude: false, params: {}, cmd: { bin: process.execPath, args: [path.join(PACKAGE_ROOT, 'tests', 'fakes', 'noisy.mjs'), '0', '20000'], cwd: PACKAGE_ROOT } });
    const run = () => app.app.inject({ method: 'POST', url: '/api/actions/daily.runNow', headers: app.authedWrite, payload: { params: {}, confirmed: true } });
    try {
      const answers = await Promise.all([run(), run()]);
      expect(answers.map((a) => a.statusCode).sort()).toEqual([202, 409]);
      expect(answers.find((a) => a.statusCode === 409)!.json().error).toMatch(/^Skipped: the daily job is already queued/);
      expect(app.runner.pending('daily.runNow')).toHaveLength(1);
    } finally {
      slowProbe.mockRestore();
      for (const m of app.runner.pending('daily.runNow')) app.runner.cancel(m.id);
      app.runner.cancel(blocker.id);
      for (let i = 0; i < 200 && !app.runner.store.readExit(blocker.id); i++) await new Promise((r) => setTimeout(r, 50));
      await app.close();
    }
  });

  it('a queued daily run another process settled on disk (cancelled in a blue/green handover) does not block a new one (SW6-server-03 review 2)', async () => {
    const app = await makeTestApp();
    const blocker = app.runner.start({ actionId: 'test.noisy', label: 'noisy', cost: 'free', resources: ['pipeline'], claude: false, params: {}, cmd: { bin: process.execPath, args: [path.join(PACKAGE_ROOT, 'tests', 'fakes', 'noisy.mjs'), '0', '20000'], cwd: PACKAGE_ROOT } });
    const run = () => app.app.inject({ method: 'POST', url: '/api/actions/daily.runNow', headers: app.authedWrite, payload: { params: {}, confirmed: true } });
    try {
      const first = await run();
      expect(first.statusCode, first.body).toBe(202);
      const id = first.json().runId as string;
      app.runner.store.write({ ...app.runner.store.read(id)!, status: 'cancelled', endedAt: new Date().toISOString() });
      const second = await run();
      expect(second.statusCode, second.body).toBe(202);
      expect(app.runner.pending('daily.runNow').map((m) => m.id)).toEqual([second.json().runId]);
      expect(app.runner.queuedIds()).not.toContain(id);
    } finally {
      for (const m of app.runner.pending('daily.runNow')) app.runner.cancel(m.id);
      app.runner.cancel(blocker.id);
      for (let i = 0; i < 200 && !app.runner.store.readExit(blocker.id); i++) await new Promise((r) => setTimeout(r, 50));
      await app.close();
    }
  });

  it('a daily run the app starts asks run-daily.sh to exit 75 when it finds the job already running, so the run is not shown as done', async () => {
    const started: Array<Parameters<typeof t.runner.start>[0]> = [];
    const spy = vi.spyOn(t.runner, 'start').mockImplementation((req) => {
      started.push(req);
      return { id: '20261005000000-abcdef' } as RunMeta;
    });
    try {
      expect((await post('/api/actions/daily.runNow', { params: {}, confirmed: true })).statusCode).toBe(202);
      expect(started[0]!.env).toMatchObject({ CC_RUN_DAILY_SKIP_EXIT: '75' });
    } finally {
      spy.mockRestore();
    }
  });

  it('Run the daily job now pins the node the scheduled job is pinned to (CC_NODE_BIN), so it never runs on an older node first on PATH (SW7-server-02)', async () => {
    const started: Array<Parameters<typeof t.runner.start>[0]> = [];
    const spy = vi.spyOn(t.runner, 'start').mockImplementation((req) => {
      started.push(req);
      return { id: '20261005000000-abcdef' } as RunMeta;
    });
    try {
      expect((await post('/api/actions/daily.runNow', { params: {}, confirmed: true })).statusCode).toBe(202);
      expect(path.isAbsolute(pinnedNodeBin())).toBe(true);
      expect(started[0]!.env).toMatchObject({ CC_NODE_BIN: pinnedNodeBin() });
    } finally {
      spy.mockRestore();
    }
  });

  it('Run the daily job now passes no CC_CLAUDE_BIN when the app has no absolute claude, so the job looks it up itself', async () => {
    const bare = await makeTestApp({ claudeBin: 'claude' });
    const started: Array<Parameters<typeof bare.runner.start>[0]> = [];
    const spy = vi.spyOn(bare.runner, 'start').mockImplementation((req) => {
      started.push(req);
      return { id: '20261005000000-abcdef' } as RunMeta;
    });
    try {
      const res = await bare.app.inject({ method: 'POST', url: '/api/actions/daily.runNow', headers: bare.authedWrite, payload: { params: {}, confirmed: true } });
      expect(res.statusCode, res.body).toBe(202);
      expect(started[0]!.env).not.toHaveProperty('CC_CLAUDE_BIN');
    } finally {
      spy.mockRestore();
      await bare.close();
    }
  });

  it('cancel stops a running run when the request says JSON but carries no body, the way a browser button sends it', async () => {
    const run = t.runner.start({ actionId: 'test.noisy', label: 'noisy', cost: 'free', resources: [], claude: false, params: {}, cmd: { bin: process.execPath, args: [path.join(PACKAGE_ROOT, 'tests', 'fakes', 'noisy.mjs'), '0', '20000'], cwd: PACKAGE_ROOT } });
    const res = await t.app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel`, headers: { ...t.authedWrite, 'content-type': 'application/json' } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await waitForRun(run.id)).status).toBe('cancelled');
  });

  it('cancel still refuses a body that is not valid JSON', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/runs/does-not-exist/cancel', headers: t.authedWrite, payload: '{"half":' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('FST_ERR_CTP_INVALID_JSON_BODY');
  });

  it('actions need the write headers like every other mutation', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/actions/system.doctor', headers: t.authed, payload: { params: {} } });
    expect(res.statusCode).toBe(403);
  });
});

describe('docs.prepareApplication (zero-token prefill)', () => {
  const GREENHOUSE = 'https://boards.greenhouse.io/acmerobotics/jobs/12345';

  it('the Apply page request with only a posting URL is refused with a readable reason, never the script usage text', async () => {
    const res = await post('/api/actions/docs.prepareApplication', { params: { url: 'https://www.builtinaustin.com/job/associate-software-engineer-python-ai/10931484' } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).not.toMatch(/Usage:/);
  });

  it('runs the script with --url and --pdf and returns the prefill summary inline', async () => {
    const res = await post('/api/actions/docs.prepareApplication', { params: { url: GREENHOUSE, pdf: 'output/acme-robotics-cv.pdf' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().result).toContain('Greenhouse');
    expect(res.json().result).toMatch(/resume\s+acme-robotics-cv\.pdf/);
  });

  it('passes a cover letter text file with --cover when one is chosen', async () => {
    fs.writeFileSync(path.join(t.cfg.dataRoot, 'output', 'acme-robotics-cover.txt'), 'Dear team, three short words.\n');
    const res = await post('/api/actions/docs.prepareApplication', { params: { url: GREENHOUSE, pdf: 'output/acme-robotics-cv.pdf', cover: 'output/acme-robotics-cover.txt' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().result).toMatch(/Cover\s+output\/acme-robotics-cover\.txt \(5 words\)/);
  });

  it('accepts a tailored CV inside an application bundle under output/', async () => {
    const dir = path.join(t.cfg.dataRoot, 'output', '001-acme-robotics-senior-backend-engineer', 'cv', 'tailored', 'v001');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cv.pdf'), '%PDF-1.4\n');
    const res = await post('/api/actions/docs.prepareApplication', { params: { url: GREENHOUSE, pdf: 'output/001-acme-robotics-senior-backend-engineer/cv/tailored/v001/cv.pdf' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().result).toMatch(/resume\s+cv\.pdf/);
  });

  it('explains that a job-board listing is not an ATS apply link before running anything', async () => {
    const res = await post('/api/actions/docs.prepareApplication', { params: { url: 'https://www.builtinaustin.com/job/associate-software-engineer-python-ai/10931484', pdf: 'output/acme-robotics-cv.pdf' } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toMatch(/Greenhouse, Ashby and Lever/);
    expect(res.json().error).toContain('www.builtinaustin.com');
  });

  it('refuses a CV PDF that does not exist with a readable reason', async () => {
    const res = await post('/api/actions/docs.prepareApplication', { params: { url: GREENHOUSE, pdf: 'output/nope.pdf' } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe('The CV PDF output/nope.pdf does not exist. Generate the tailored CV first or choose another PDF.');
  });

  it('refuses a missing cover letter file with a readable reason', async () => {
    const res = await post('/api/actions/docs.prepareApplication', { params: { url: GREENHOUSE, pdf: 'output/acme-robotics-cv.pdf', cover: 'output/missing-cover.txt' } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe('The cover letter output/missing-cover.txt does not exist. Choose another or leave it out.');
  });

  it.each([
    ['a file outside output/', 'cv.md'],
    ['a parent-directory escape', 'output/../cv.md'],
    ['a non-PDF file', 'output/acme-robotics-cv.html'],
    ['an absolute path', '/etc/hosts.pdf'],
  ])('rejects %s as the CV', async (_label, pdf) => {
    const res = await post('/api/actions/docs.prepareApplication', { params: { url: GREENHOUSE, pdf } });
    expect(res.statusCode, res.body).toBe(400);
  });

  it('rejects a PDF symlinked from output/ to a file outside it', async () => {
    const outside = path.join(t.cfg.dataRoot, 'outside.pdf');
    fs.writeFileSync(outside, '%PDF-1.4\n');
    fs.symlinkSync(outside, path.join(t.cfg.dataRoot, 'output', 'linked.pdf'));
    const res = await post('/api/actions/docs.prepareApplication', { params: { url: GREENHOUSE, pdf: 'output/linked.pdf' } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toMatch(/does not exist/);
  });

  it('rejects a cover letter that is not a text file', async () => {
    const res = await post('/api/actions/docs.prepareApplication', { params: { url: GREENHOUSE, pdf: 'output/acme-robotics-cv.pdf', cover: 'output/globex-payments-cv.pdf' } });
    expect(res.statusCode, res.body).toBe(400);
  });
});

describe('Apply documents', () => {
  it('suggests the indexed tailored CV for a tracker row and lists every CV PDF and text cover letter under output/', async () => {
    fs.writeFileSync(path.join(t.cfg.dataRoot, 'output', 'acme-robotics-cover.txt'), 'Dear team.\n');
    fs.writeFileSync(path.join(t.cfg.dataRoot, 'output', 'acme-robotics-cover.pdf'), '%PDF-1.4\n');
    const res = await get('/api/apply/documents?n=1');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.suggestedPdf).toBe('output/acme-robotics-cv.pdf');
    expect(body.suggestedCover).toBe('output/acme-robotics-cover.txt');
    expect(body.pdfs).toEqual(expect.arrayContaining(['output/acme-robotics-cv.pdf', 'output/acme-robotics-extra.pdf', 'output/globex-payments-cv.pdf']));
    expect(body.pdfs).not.toContain('output/acme-robotics-cover.pdf');
    expect(body.covers).toEqual(['output/acme-robotics-cover.txt']);
  });

  it('suggests nothing for a row without a tailored CV', async () => {
    const body = (await get('/api/apply/documents?n=2')).json();
    expect(body.suggestedPdf).toBeNull();
    expect(body.suggestedCover).toBeNull();
    expect(body.pdfs.length).toBeGreaterThan(0);
  });

  it('suggests nothing without a row and rejects a bad row number', async () => {
    const body = (await get('/api/apply/documents')).json();
    expect(body.suggestedPdf).toBeNull();
    expect(body.pdfs).toContain('output/globex-payments-cv.pdf');
    expect((await get('/api/apply/documents?n=abc')).statusCode).toBe(400);
    expect((await get('/api/apply/documents?n=99')).statusCode).toBe(404);
  });
});

describe('docs.prepareApplication when the script itself fails', () => {
  // Only the prefill script is replaced; every other child process runs for real.
  const failing = (stderr: string, code = 1): Exec => (cmd, args, opts) => (args[0]?.endsWith('prepare-application.mjs') ? Promise.resolve({ code, stdout: '', stderr }) : execNoShell(cmd, args, opts));
  const prefill = async (exec: Exec) => {
    const app = await makeTestApp({}, { exec });
    try {
      return await app.app.inject({ method: 'POST', url: '/api/actions/docs.prepareApplication', headers: app.authedWrite, payload: { params: { url: 'https://boards.greenhouse.io/acme/jobs/1', pdf: 'output/acme-robotics-cv.pdf' } } });
    } finally {
      await app.close();
    }
  };

  it('turns the script error lines into a readable 422', async () => {
    const res = await prefill(failing('Error: URL not recognized as Greenhouse, Ashby, or Lever.\n  URL: https://boards.greenhouse.io/acme/jobs/1\n'));
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error).toBe('Prefill could not run: URL not recognized as Greenhouse, Ashby, or Lever.');
    expect(res.json().stderr).toBeUndefined();
  });

  it('still says what happened when the script fails without an error line', async () => {
    const res = await prefill(failing('TypeError: boom\n    at main (prepare-application.mjs:9:1)\n', 2));
    expect(res.statusCode, res.body).toBe(502);
    expect(res.json().error).toBe('Prefill failed: prepare-application.mjs exited 2 (last output: at main (prepare-application.mjs:9:1)).');
  });
});

describe('Apply documents classification and suggestion', () => {
  let a: TestApp;
  beforeAll(async () => {
    a = await makeTestApp();
  });
  afterAll(async () => {
    await a.close();
  });
  const out = (rel: string) => {
    const file = path.join(a.cfg.dataRoot, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '%PDF-1.4\n');
  };
  const docs = async (n?: number) => (await a.app.inject({ method: 'GET', url: `/api/apply/documents${n ? `?n=${n}` : ''}`, headers: a.authed })).json();

  it('keeps a CV whose company or role merely contains the word cover, and one the PDF manifest marks cv', async () => {
    out('output/cv-jane-cover-genius-2026-10-04.pdf');
    out('output/cover-genius-staff-engineer-2026-10-04.pdf');
    out('output/cv-jane-cover-genius-2026-10-04.md');
    fs.appendFileSync(path.join(a.cfg.dataRoot, 'data', 'pdf-index.tsv'), '4\toutput/cover-genius-staff-engineer-2026-10-04.pdf\t\tletter\t2026-10-04\tcv\n');
    const body = await docs();
    expect(body.pdfs).toContain('output/cv-jane-cover-genius-2026-10-04.pdf');
    expect(body.pdfs).toContain('output/cover-genius-staff-engineer-2026-10-04.pdf');
    expect(body.covers).not.toContain('output/cv-jane-cover-genius-2026-10-04.md');
  });

  it('drops cover letters named the way the cover flow names them, or marked cover in the PDF manifest', async () => {
    out('output/globex-payments-staff-software-engineer-cover.pdf');
    out('output/cover_globex.pdf');
    out('output/globex-letter.pdf');
    fs.appendFileSync(path.join(a.cfg.dataRoot, 'data', 'pdf-index.tsv'), '3\toutput/globex-letter.pdf\t\tletter\t2026-09-26\tcover\n');
    const body = await docs();
    expect(body.pdfs).not.toContain('output/globex-payments-staff-software-engineer-cover.pdf');
    expect(body.pdfs).not.toContain('output/cover_globex.pdf');
    expect(body.pdfs).not.toContain('output/globex-letter.pdf');
  });

  it('suggests the CV indexed under the row report number, not under the tracker row number', async () => {
    const tracker = path.join(a.cfg.dataRoot, 'data', 'applications.md');
    fs.appendFileSync(tracker, '| 9 | 2026-10-01 | Acme Robotics | - | Platform Engineer | 4.0/5 | Evaluated | ✅ | [1](../reports/001-acme-robotics.md) | second role |\n');
    fs.appendFileSync(path.join(a.cfg.dataRoot, 'data', 'pdf-index.tsv'), '9\toutput/globex-payments-cv.pdf\t\tletter\t2026-10-01\tcv\n');
    expect((await docs(9)).suggestedPdf).toBe('output/acme-robotics-cv.pdf');
  });

  it('suggests the newest tailored CV in the report application bundle when the manifest has none', async () => {
    out('output/006-vandelay-systems-senior-python-engineer/cv/tailored/v002/cv.pdf');
    out('output/006-vandelay-systems-senior-python-engineer/cv/tailored/v010/cv.pdf');
    out('output/006-vandelay-systems-senior-python-engineer/cv/source/original.pdf');
    expect((await docs(6)).suggestedPdf).toBe('output/006-vandelay-systems-senior-python-engineer/cv/tailored/v010/cv.pdf');
  });
});

describe('stale action inputs', () => {
  it('are swept at startup: input files and CV uploads older than a day go, newer ones stay', async () => {
    const dataRoot = copyFixtureRoot();
    const dir = (name: string) => path.join(dataRoot, 'data', 'control-center', name);
    const files = { oldInput: path.join(dir('tmp'), 'old.txt'), newInput: path.join(dir('tmp'), 'new.txt'), oldUpload: path.join(dir('uploads'), '1-cv.pdf') };
    for (const f of Object.values(files)) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, 'x');
    }
    const past = new Date(Date.now() - 2 * 24 * 3_600_000);
    for (const f of [files.oldInput, files.oldUpload]) fs.utimesSync(f, past, past);
    const app = await makeTestApp({ dataRoot });
    try {
      expect(Object.values(files).map((f) => fs.existsSync(f))).toEqual([false, true, false]);
    } finally {
      await app.close();
    }
  });
});

describe('Hired Wall answers (R7-01)', () => {
  // The oferta mode writes the Report cell with a zero-padded label (`[001](reports/001-...)`, modes/oferta.md);
  // hired-share.mjs matches the cell's first digit run as text, so "006" must reach it, never 6.
  it('records the answer and drafts the story for a row whose report label is zero-padded, using the report the tracker API gives the row', async () => {
    const dataRoot = copyFixtureRoot();
    const trackerFile = path.join(dataRoot, 'data', 'applications.md');
    const text = fs.readFileSync(trackerFile, 'utf8').replace('| Responded |', '| Hired |').replace('[6](../reports/006-vandelay-systems.md)', '[006](../reports/006-vandelay-systems.md)');
    fs.writeFileSync(trackerFile, text);
    const app = await makeTestApp({ dataRoot });
    try {
      const rows = (await app.app.inject({ method: 'GET', url: '/api/tracker', headers: app.authed })).json().rows as Array<{ num: number; reportLabel: unknown }>;
      const row = rows.find((r) => r.num === 6)!;
      expect(row.reportLabel).toBe('006');
      const send = (id: string, params: Record<string, unknown>) => app.app.inject({ method: 'POST', url: `/api/actions/${id}`, headers: app.authedWrite, payload: { params } });
      const draft = await send('tracker.hiredShare', { report: row.reportLabel, anonymity: 'role' });
      expect(draft.statusCode, draft.body).toBe(200);
      const mark = await send('tracker.hiredMark', { report: row.reportLabel, mark: 'later' });
      expect(mark.statusCode, mark.body).toBe(200);
      const state = JSON.parse(fs.readFileSync(path.join(dataRoot, 'data', '.hired-share-state.json'), 'utf8'));
      expect(state.byReport['006'].status).toBe('later');
    } finally {
      await app.close();
    }
  });
});

describe('Export vCard (R8-03)', () => {
  // contacts.mjs --vcf writes the cards to a file inside the code checkout and prints one status line, so the
  // action must hand back the cards themselves, built by contacts.mjs's own parseContacts and buildVcf.
  const send = (app: TestApp, params: Record<string, unknown>) => app.app.inject({ method: 'POST', url: '/api/actions/followups.contactsVcf', headers: app.authedWrite, payload: { params } });

  it('returns the vCard of data/contacts.tsv for a data root outside the checkout, and writes no file', async () => {
    const app = await makeTestApp();
    try {
      expect(path.relative(app.cfg.codeRoot, app.cfg.dataRoot).startsWith('..')).toBe(true);
      const res = await send(app, {});
      expect(res.statusCode, res.body).toBe(200);
      const vcf = res.json().result as string;
      expect(vcf.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n')).toBe(true);
      expect(vcf.endsWith('END:VCARD\r\n')).toBe(true);
      expect(vcf.match(/BEGIN:VCARD/g)).toHaveLength(2);
      expect(vcf).toContain('FN:Pat Example\r\n');
      expect(vcf).toContain('EMAIL;TYPE=INTERNET:pat@acme-robotics.example');
      expect(fs.existsSync(path.join(app.cfg.dataRoot, 'output', 'contacts.vcf'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('caller id is a switch that names each card after its company and type', async () => {
    const app = await makeTestApp();
    try {
      const res = await send(app, { callerId: true });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().result).toContain('FN:Pat Example (Acme Robotics recruiter)\r\n');
      expect((await send(app, { callerId: 'career-ops' })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('with no contacts says there is nothing to export instead of downloading an empty file', async () => {
    const app = await makeTestApp();
    try {
      fs.writeFileSync(path.join(app.cfg.dataRoot, 'data', 'contacts.tsv'), '# name\tcompany\n');
      const res = await send(app, {});
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toMatch(/No contacts to export/);
    } finally {
      await app.close();
    }
  });
});

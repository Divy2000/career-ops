// A session that ends in an error without ever running shows it on its open page, through the app's event stream: a
// turn that fails before it starts, and a running turn whose run record a restart finds gone.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { E2E_PORT, E2E_TOKEN } from '../../playwright.config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..', '..');

/** Follows the app event stream from inside the page and keeps this session's events, as the session page receives them. */
async function collectSessionEvents(page: Page, id: string): Promise<() => Promise<Array<{ type: string; status?: string; reason?: string }>>> {
  await page.evaluate((sessionId) => {
    const w = window as unknown as { __events: unknown[]; __eventsOpen: boolean };
    w.__events = [];
    w.__eventsOpen = false;
    const es = new EventSource('/api/events');
    es.onopen = () => (w.__eventsOpen = true);
    es.addEventListener('session.event', (e) => {
      const frame = JSON.parse((e as MessageEvent).data) as { sessionId?: string; stored?: { event: unknown } };
      if (frame.sessionId === sessionId && frame.stored) w.__events.push(frame.stored.event);
    });
  }, id);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __eventsOpen: boolean }).__eventsOpen)).toBe(true);
  return () => page.evaluate(() => (window as unknown as { __events: Array<{ type: string; status?: string; reason?: string }> }).__events);
}

/** Marks the loaded document, so a later check proves the page was never reloaded. */
const markPage = (page: Page) => page.evaluate(() => ((window as unknown as { __marker: string }).__marker = 'still-this-page'));
const samePage = (page: Page) => page.evaluate(() => (window as unknown as { __marker?: string }).__marker);

async function untilDone(page: Page, base: string, id: string) {
  await expect.poll(async () => (await (await page.request.get(`${base}/api/sessions/${id}`)).json()).meta.status, { timeout: 30_000 }).toBe('done');
}

test.describe('a session that errors without running shows the error on its open page', () => {
  test('a follow-up turn that fails before it starts: the page shows the error status live, from /api/events', async ({ page }) => {
    // A read-only folder is how the turn is made to fail; chmod does not stop root (SW4-tests-25).
    test.skip(process.getuid?.() === 0, 'chmod does not make a folder read-only for root');
    const base = `http://127.0.0.1:${E2E_PORT}`;
    const write = { 'X-CC': '1', Origin: base };
    await page.goto(`/auth?t=${E2E_TOKEN}`);
    const { id } = (await (await page.request.post('/api/sessions', { data: { mode: 'advisor', prompt: 'What is overdue?' }, headers: write })).json()) as { id: string };
    await untilDone(page, base, id);
    await page.goto(`/sessions/${id}`);
    const panel = page.locator(`[data-session-id="${id}"]`);
    await expect(panel.getByText('done', { exact: true })).toBeVisible();
    const events = await collectSessionEvents(page, id);
    await markPage(page);
    // The next turn cannot write its policy (its folder under the guard dir is read-only), so it fails before it spawns.
    const turns = path.join(process.env.CC_E2E_TMP!, 'guard', 'sessions', id, 'turns');
    fs.chmodSync(turns, 0o500);
    try {
      await panel.getByLabel('Reply to the session').fill('And next week?');
      await panel.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(panel.getByText('error', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(panel.getByRole('alert')).toContainText('EACCES');
      // The terminal status event's reason, under the transcript: the session ended, not just one message failed.
      await expect(panel.locator('p', { hasText: 'EACCES' })).toBeVisible();
    } finally {
      fs.chmodSync(turns, 0o755);
    }
    expect(await samePage(page)).toBe('still-this-page');
    const seen = await events();
    expect(seen.map((e) => e.type)).toEqual(['error', 'status']);
    expect(seen.at(-1)).toMatchObject({ type: 'status', status: 'error', reason: expect.stringContaining('EACCES') });
    expect((await (await page.request.get(`/api/sessions/${id}`)).json()).meta.status).toBe('error');
  });

  test('a running turn whose run record is gone after a restart: the page shows the error once the new server takes over', async ({ browser }) => {
    test.setTimeout(120_000);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-restart-'));
    const root = path.join(tmp, 'root');
    fs.cpSync(path.join(pkg, 'tests', 'fixtures', 'root'), root, { recursive: true });
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const { port: p } = s.address() as net.AddressInfo;
        s.close(() => resolve(p));
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const token = 'e2e-restart-token';
    const sup: ChildProcess = spawn(path.join(pkg, 'node_modules', '.bin', 'tsx'), [path.join(pkg, 'supervisor', 'index.ts')], {
      cwd: pkg,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        CC_PORT: String(port),
        CC_TOKEN: token,
        CC_DATA_ROOT: root,
        CC_GUARD_DIR: path.join(tmp, 'guard'),
        CC_CLAUDE_BIN: path.join(pkg, 'tests', 'fakes', 'claude.mjs'),
        FAKE_CLAUDE_SCENARIO_DIR: path.join(pkg, 'tests', 'fixtures', 'scenarios'),
        CC_FAKE_TOKEN: 'e2e-restart-fake-token',
        CC_FAKE_LAUNCHD: '1',
        CC_LAUNCH_AGENTS_DIR: path.join(root, '.launch-agents'),
        CC_CLAUDE_PROJECTS_DIR: path.join(root, '.claude-projects'),
        CC_NO_OPEN: '1',
        CC_NO_RELOAD: '1',
        CC_FAKE_DAILY: 'idle',
        CC_FAKE_PLATFORM: 'darwin',
        CC_FAKE_MANAGED_SETTINGS_DIR: path.join(tmp, 'managed-settings'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    sup.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    sup.stderr!.on('data', (d: Buffer) => (out += d.toString()));
    const ctx = await browser.newContext();
    try {
      await expect.poll(() => out.includes('Control Center ready'), { timeout: 60_000, message: out }).toBe(true);
      const page = await ctx.newPage();
      // The e2e app serves the client through Vite's dev server, whose live-reload socket reloads the page when the server
      // child is replaced. A built app has no such socket: hold it open here, so what the page shows after the restart
      // comes from the app's own event stream and not from a fresh page load.
      await page.routeWebSocket((url) => url.pathname === '/' && url.searchParams.has('token'), () => undefined);
      await page.goto(`${base}/auth?t=${token}`);
      const write = { 'X-CC': '1', Origin: base };
      const { id } = (await (await page.request.post(`${base}/api/sessions`, { data: { mode: 'advisor', prompt: 'What is overdue?' }, headers: write })).json()) as { id: string };
      await untilDone(page, base, id);
      // What a server that died during turn 2 leaves behind, with its run record lost: a running session, a running
      // event, and no run for the turn. The server running now never looks again; only a new one reconciles it.
      const dir = path.join(root, 'data', 'control-center', 'sessions', id);
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as { status: string; turns: Array<Record<string, unknown>> };
      meta.status = 'running';
      meta.turns.push({ n: 2, runId: 'r-lost-in-restart', userText: 'And next week?', startedAt: new Date().toISOString(), endedAt: null, costUsd: 0, tokens: 0, permissionDenials: 0 });
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
      const lines = fs.readFileSync(path.join(dir, 'events.ndjson'), 'utf8').trim().split('\n');
      const seq = (JSON.parse(lines.at(-1)!) as { seq: number }).seq + 1;
      fs.appendFileSync(path.join(dir, 'events.ndjson'), `${JSON.stringify({ seq, ts: new Date().toISOString(), event: { type: 'status', status: 'running', turn: 2 } })}\n`);
      await page.goto(`${base}/sessions/${id}`);
      const panel = page.locator(`[data-session-id="${id}"]`);
      await expect(panel.getByText('running', { exact: true })).toBeVisible();
      await markPage(page);
      // The restart the recovery page offers: a new server child takes over and reconciles what was left running.
      const restart = await page.request.post(`${base}/__recovery/restart`, { headers: { origin: base, 'x-cc': '1' } });
      expect(restart.status(), await restart.text()).toBe(200);
      await expect(panel.getByText('error', { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(panel.getByText('run record missing after a restart')).toBeVisible();
      expect(await samePage(page)).toBe('still-this-page');
      const stored = (await (await page.request.get(`${base}/api/sessions/${id}`)).json()) as { meta: { status: string }; events: Array<{ event: { type: string; status?: string; reason?: string } }> };
      expect(stored.meta.status).toBe('error');
      expect(stored.events.at(-1)!.event).toEqual({ type: 'status', status: 'error', reason: 'run record missing after a restart', turn: 2 });
    } finally {
      await ctx.close();
      sup.kill('SIGTERM');
      await new Promise((r) => (sup.exitCode !== null ? r(null) : sup.once('exit', r)));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

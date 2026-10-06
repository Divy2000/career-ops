import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { axeBuilder } from './helpers.js';
import { E2E_PORT, E2E_TOKEN } from '../../playwright.config.js';

async function login(page: Page) {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

async function axeClean(page: Page) {
  const axe = await (await axeBuilder(page)).analyze();
  const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
}

test.describe('AI sessions through the fake Claude', () => {
  test.beforeEach(async ({ page }) => login(page));

  test('Quick evaluate streams the session, the scripted report lands, the tracker merges and the honesty gate marks done', async ({ page }) => {
    await page.getByLabel('Posting URL to evaluate').fill('https://jobs.example.com/synthetic/8');
    await page.getByRole('button', { name: 'Evaluate URL' }).click();
    await expect(page).toHaveURL(/\/sessions\/s/);
    const id = new URL(page.url()).pathname.split('/').pop()!;
    await expect(page.getByText('Evaluation complete: Synthetic Corp scored 4.1/5')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('done', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('008-synthetic-corp.md').first()).toBeVisible();
    await axeClean(page);
    // The merged tracker row, not just a row with the company's name (SW2-tests-29).
    const tracker = await (await page.request.get('/api/tracker')).json();
    expect(tracker.rows.find((r: { company: string }) => r.company === 'Synthetic Corp')).toMatchObject({ report: 8, reportState: 'ok', score: 4.1, status: 'Evaluated' });
    expect((await (await page.request.get(`/api/sessions/${id}`)).json()).meta.status).toBe('done');
    // This session's row in the list, not the first "done" cell, which older sessions from other specs also have.
    await page.getByRole('link', { name: 'Sessions', exact: true }).click();
    const row = page.getByRole('row').filter({ has: page.locator(`a[href="/sessions/${id}"]`) });
    await expect(row.getByRole('cell').first()).toHaveText('done');
    await expect(row).toContainText('oferta');
  });

  test('a session page follows its session on the app event stream and opens no stream of its own (seed: SW3-web-a-01)', async ({ page }) => {
    const streams: string[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.pathname === '/api/events' || /^\/api\/sessions\/[^/]+\/events$/.test(url.pathname)) streams.push(url.pathname);
    });
    // The app stream opened at login, before this listener: load the page again so its one stream is seen opening.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
    await page.getByLabel('Posting URL to evaluate').fill('https://jobs.example.com/synthetic/9');
    await page.getByRole('button', { name: 'Evaluate URL' }).click();
    await expect(page).toHaveURL(/\/sessions\/s/);
    await expect(page.getByText(/Evaluation complete/)).toBeVisible({ timeout: 20_000 });
    expect(streams.filter((p) => p !== '/api/events')).toEqual([]);
    expect(streams.filter((p) => p === '/api/events').length).toBeGreaterThanOrEqual(1);
  });

  test('Pipeline > Batch asks first, then starts one oferta session per URL through the fan-out', async ({ page }) => {
    const bodies: unknown[] = [];
    // Answered here so no evaluation runs: the server side of the fan-out is covered by the sessions API tests.
    await page.route('**/api/sessions/fanout', async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ sessions: [], reserved: [41, 42] }) });
    });
    await page.goto('/pipeline?tab=batch');
    await expect(page.getByText(/batch-runner/)).toHaveCount(0);
    await page.getByLabel('Batch URLs').fill('https://jobs.example.com/batch/1\nhttps://jobs.example.com/batch/2');
    await page.getByRole('button', { name: /Batch evaluate/ }).click();
    await expect(page.getByRole('dialog', { name: 'Start 2 evaluation sessions?' })).toBeVisible();
    expect(bodies).toEqual([]);
    await page.getByRole('button', { name: 'Start them' }).click();
    await expect(page).toHaveURL(/\/sessions$/);
    expect(bodies).toEqual([{ mode: 'oferta', urls: ['https://jobs.example.com/batch/1', 'https://jobs.example.com/batch/2'] }]);
  });

  test('New session and the command palette offer no batch mode, while a batch session from before stays listed and opens', async ({ page }) => {
    // The e2e roots sit under CC_E2E_TMP (playwright.config.ts): root/ is the main app's data root.
    const id = 'e2e-old-batch-session';
    const dir = path.join(process.env.CC_E2E_TMP!, 'root', 'data', 'control-center', 'sessions', id);
    fs.mkdirSync(dir, { recursive: true });
    const at = '2026-10-01T09:00:00.000Z';
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, claudeSessionId: '22222222-2222-4222-8222-222222222222', mode: 'batch', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null, status: 'done', createdAt: at, updatedAt: at, turns: [], totals: { costUsd: 0, tokens: 0 }, filesChanged: [], reportNum: null, policyVersion: 2 }));
    try {
      await page.goto('/sessions');
      await expect(page.getByRole('link', { name: 'batch', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'New session' }).click();
      const picker = page.getByLabel('New session mode');
      await expect(picker.locator('option', { hasText: /^oferta / })).toHaveCount(1);
      await expect(picker.locator('option', { hasText: /^batch / })).toHaveCount(0);
      await page.keyboard.press('Control+k');
      await page.getByPlaceholder('Go to a page, run an action or start a mode').fill('mode oferta');
      await expect(page.locator('[cmdk-item]', { hasText: /^oferta\b/ }).first()).toBeVisible();
      await page.getByPlaceholder('Go to a page, run an action or start a mode').fill('mode batch');
      await expect(page.locator('[cmdk-item]', { hasText: /^batch\b/ })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await page.getByRole('link', { name: 'batch', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/sessions/${id}$`));
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Interview practice waits for the reply and resumes the same Claude session', async ({ page }) => {
    await page.goto('/tracker/3');
    await page.getByRole('tab', { name: 'Interview' }).click();
    await page.getByLabel('Interview mode').selectOption('interview/practice');
    await page.getByRole('button', { name: 'Open prompt' }).click();
    await page.getByRole('button', { name: 'Start session' }).click();
    await expect(page.getByText('Which company is this interview for?')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('needs your reply')).toBeVisible();
    const sessionId = await page.locator('[data-session-id]').first().getAttribute('data-session-id');
    const before = await (await page.request.get(`/api/sessions/${sessionId}`)).json();
    await page.getByLabel('Reply to the session').fill('Globex Payments');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('First question delivered in the practice file.')).toBeVisible({ timeout: 20_000 });
    const after = await (await page.request.get(`/api/sessions/${sessionId}`)).json();
    expect(after.meta.turns).toHaveLength(2);
    expect(after.meta.claudeSessionId).toBe(before.meta.claudeSessionId);
    await page.getByRole('tab', { name: 'Sessions' }).click();
    await expect(page.getByRole('link', { name: 'interview/practice' })).toBeVisible();
  });

  test('Apply drafts answers into an editable form and says the headed fill is unavailable', async ({ page }) => {
    await page.goto('/apply/1');
    await expect(page.getByText('Never submits. You press Submit.')).toBeVisible();
    await expect(page.getByText('drafts answers only')).toBeVisible();
    await page.getByRole('button', { name: 'Draft answers' }).click();
    const why = page.getByLabel(/Why do you want to work here/);
    await expect(why).toBeVisible({ timeout: 20_000 });
    await expect(why).toHaveValue('Because the platform work matches my background.');
    await why.fill('Edited answer');
    await expect(page.getByText('needs your confirmation').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fill real form' })).toBeDisabled();
    await axeClean(page);
  });

  test('Ask drawer proposes actions; navigate runs directly and setStatus asks first', async ({ page }) => {
    await page.getByRole('button', { name: 'Open Ask drawer' }).click();
    await page.getByLabel('Prompt for advisor').fill('What should I do next?');
    await page.getByRole('button', { name: 'Ask the advisor' }).click();
    await expect(page.getByText('You have one overdue follow-up at Globex Payments.')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Set row #1 to Responded')).toBeVisible();
    await page.getByRole('button', { name: 'Review and run' }).click();
    await page.getByRole('dialog', { name: 'The advisor proposes a write' }).getByRole('button', { name: 'Do it' }).click();
    await expect(page.locator('li.proposal[data-proposal-state="done"]')).toHaveCount(1);
    const detail = await (await page.request.get('/api/tracker/1')).json();
    expect(detail.row.status).toBe('Responded');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page).toHaveURL(/\/tracker(\?|$)/);
    await expect(page.getByRole('heading', { level: 1, name: 'Tracker' })).toBeVisible();
  });

  test('a held or double-pressed Enter on Review and run opens the write confirm on Cancel, so it declines (SW4-web-a-02)', async ({ page }) => {
    await page.getByRole('button', { name: 'Open Ask drawer' }).click();
    await page.getByLabel('Prompt for advisor').fill('What should I do next?');
    await page.getByRole('button', { name: 'Ask the advisor' }).click();
    await expect(page.getByText('Set row #1 to Responded')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Review and run' }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'The advisor proposes a write' });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('li.proposal[data-proposal-state="rejected"]')).toContainText('declined');
  });

  test('closing and reopening the Ask drawer keeps the advisor conversation and its proposals (SW-web-a-13)', async ({ page }) => {
    await page.getByRole('button', { name: 'Open Ask drawer' }).click();
    await page.getByLabel('Prompt for advisor').fill('What should I follow up on this week?');
    await page.getByRole('button', { name: 'Ask the advisor' }).click();
    await page.getByRole('button', { name: 'Close Ask' }).click();
    await expect(page.getByRole('dialog', { name: 'Ask' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Open Ask drawer' }).click();
    const drawer = page.getByRole('dialog', { name: 'Ask' });
    await expect(drawer.getByText('You have one overdue follow-up at Globex Payments.')).toBeVisible({ timeout: 20_000 });
    await expect(drawer.getByText('Set row #1 to Responded')).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Ask again' })).toBeVisible();
  });

  test('finished sessions on one page do not use up the browser connections: six of them, then the app still loads (SW3-web-a-01)', async ({ page }) => {
    // Chromium allows 6 HTTP/1.1 connections to one host, and Shell's live event stream holds one. A session stream that
    // stays open after its turn ends holds another, so the sixth session (or the next fetch) used to hang.
    await page.goto('/tracker/3');
    await page.getByRole('tab', { name: 'Interview' }).click();
    for (let i = 1; i <= 6; i++) {
      await page.getByRole('button', { name: 'Open prompt' }).click();
      await page.getByRole('button', { name: 'Start session' }).first().click();
      await expect(page.getByRole('paragraph').filter({ hasText: /^Working on it\. Done\.$/ })).toHaveCount(i, { timeout: 20_000 });
    }
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Tracker' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tracker' })).toBeVisible();
    await expect(page.locator('tbody tr')).not.toHaveCount(0, { timeout: 10_000 });
  });

  test('AI search lists offers, marks known URLs and adds a new one to the pipeline', async ({ page }) => {
    await page.goto('/discover?tab=ai');
    await page.getByLabel('Prompt for ai-search').fill('Senior platform engineer, remote, sponsors visas');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByRole('cell', { name: 'Synthetic Corp' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('already known')).toBeVisible();
    await page.getByRole('row', { name: /Synthetic Corp/ }).getByRole('button', { name: 'Add' }).click();
    await expect(page.getByText('Added 1 to the pipeline')).toBeVisible();
    const pipeline = await (await page.request.get('/api/pipeline')).json();
    expect(pipeline.rows.some((r: { url: string }) => r.url === 'https://jobs.example.com/synthetic/900')).toBe(true);
  });

  test('Sponsorship AI policy pass writes inside its scope and the digest refreshes', async ({ page }) => {
    await page.goto('/sponsorship');
    await page.getByRole('button', { name: /Run AI policy pass/ }).click();
    await expect(page.getByText('Policy pass complete')).toBeVisible({ timeout: 20_000 });
    await page.reload();
    await expect(page.getByRole('heading', { name: '2026-10-03' })).toBeVisible();
  });

  test('Profile imports a pasted CV and saves it as cv.md', async ({ page }) => {
    await page.goto('/profile');
    await page.getByLabel('CV markdown').fill('# Jane Candidate\n\nPlatform engineer.');
    await page.getByRole('button', { name: 'Save as cv.md' }).click();
    // The fixture root has a cv.md, so replacing it is confirmed first, naming the CV that is there (SW-tests-09).
    const replace = page.getByRole('dialog', { name: 'Replace cv.md?' });
    await expect(replace).toContainText('# Alex Example');
    await replace.getByRole('button', { name: 'Replace cv.md' }).click();
    await expect(page.getByText('cv.md saved.')).toBeVisible();
    const cv = await (await page.request.get('/api/files/user/cv')).json();
    expect(cv.text).toContain('Jane Candidate');
    await axeClean(page);
  });
});

test.describe('Fork on a session page', () => {
  test.beforeEach(async ({ page }) => login(page));

  test('opens the forked session, which says where it came from', async ({ page }) => {
    const res = await page.request.post('/api/sessions', { data: { mode: 'interview/practice', target: { type: 'app', value: '3' }, prompt: 'Practice' }, headers: { 'X-CC': '1', Origin: `http://127.0.0.1:${E2E_PORT}` } });
    expect(res.status(), await res.text()).toBe(202);
    const { id } = (await res.json()) as { id: string };
    await page.goto(`/sessions/${id}`);
    await expect(page.getByText('needs your reply', { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByLabel('Reply to the session').fill('Try a different angle');
    await page.getByRole('button', { name: 'Fork', exact: true }).click();
    await expect(page).not.toHaveURL(new RegExp(`/sessions/${id}$`));
    await expect(page).toHaveURL(/\/sessions\/s[\w-]+$/);
    await expect(page.getByText(`forked from ${id}`)).toBeVisible();
    const forkId = new URL(page.url()).pathname.split('/').at(-1)!;
    await expect(page.locator(`[data-session-id="${forkId}"]`)).toBeVisible();
  });
});

test.describe('Delete on a session page', () => {
  test.beforeEach(async ({ page }) => login(page));

  test('the next session opened from the same page shows its transcript, not "Session deleted."', async ({ page }) => {
    const res = await page.request.post('/api/sessions', { data: { mode: 'interview/practice', target: { type: 'app', value: '3' }, prompt: 'Practice' }, headers: { 'X-CC': '1', Origin: `http://127.0.0.1:${E2E_PORT}` } });
    expect(res.status(), await res.text()).toBe(202);
    const { id } = (await res.json()) as { id: string };
    await page.goto(`/sessions/${id}`);
    await expect(page.getByText('needs your reply', { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog', { name: 'Delete this session?' }).getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('Session deleted.')).toBeVisible();
    // Cmd+K starts a mode session and opens it on the same route, so the page is not remounted.
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Go to a page, run an action or start a mode').fill('mode interview/practice');
    await page.locator('[cmdk-item]', { hasText: /^interview\/practice\b/ }).first().click();
    await page.getByLabel('Session prompt').fill('Practice again');
    await page.getByRole('button', { name: 'Start (uses tokens)' }).click();
    await expect(page).not.toHaveURL(new RegExp(`/sessions/${id}$`));
    await expect(page).toHaveURL(/\/sessions\/s[\w-]+$/);
    const next = new URL(page.url()).pathname.split('/').at(-1)!;
    await expect(page.getByRole('heading', { level: 1 })).toContainText(next);
    await expect(page.locator(`[data-session-id="${next}"]`)).toBeVisible();
    await expect(page.getByText('Session deleted.')).toHaveCount(0);
  });
});

test.describe('Cancel stops a running session or run from the page', () => {
  test.beforeEach(async ({ page }) => login(page));

  /** A calibrate session: the fake CLI streams once, then sleeps 15 s, so it is still running when the button is clicked. */
  async function startSlowSession(page: Page): Promise<{ id: string; runId: string }> {
    const res = await page.request.post('/api/sessions', { data: { mode: 'calibrate', prompt: 'Calibrate slowly' }, headers: { 'X-CC': '1', Origin: `http://127.0.0.1:${E2E_PORT}` } });
    expect(res.status(), await res.text()).toBe(202);
    const meta = (await res.json()) as { id: string; turns: Array<{ runId: string }> };
    return { id: meta.id, runId: meta.turns[0]!.runId };
  }
  /** The Runs table names the action, not the run id; the calibrate turn is the only calibrate run still running. */
  const runningRow = (page: Page) => page.getByRole('row').filter({ hasText: 'session.calibrate' }).filter({ has: page.getByText('running', { exact: true }) });
  const runStatus = async (page: Page, runId: string) => ((await (await page.request.get(`/api/runs/${runId}`)).json()) as { meta: { status: string } }).meta.status;
  const sessionStatus = async (page: Page, id: string) => ((await (await page.request.get(`/api/sessions/${id}`)).json()) as { meta: { status: string } }).meta.status;

  test('Cancel on a running session page ends the session as cancelled', async ({ page }) => {
    const { id } = await startSlowSession(page);
    await page.goto(`/sessions/${id}`);
    const panel = page.locator(`[data-session-id="${id}"]`);
    await expect(panel.getByText('running', { exact: true })).toBeVisible({ timeout: 10_000 });
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(panel.getByText('cancelled', { exact: true })).toBeVisible({ timeout: 10_000 });
    expect(await sessionStatus(page, id)).toBe('cancelled');
    await expect(panel.getByRole('alert')).toHaveCount(0);
  });

  test('Cancel on a running row in Runs & Schedule ends the run as cancelled', async ({ page }) => {
    const { id, runId } = await startSlowSession(page);
    await page.goto('/runs');
    const row = runningRow(page);
    await expect(row).toHaveCount(1, { timeout: 10_000 });
    await row.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(row).toHaveCount(0, { timeout: 10_000 });
    expect(await runStatus(page, runId)).toBe('cancelled');
    await expect.poll(() => sessionStatus(page, id), { timeout: 10_000 }).not.toBe('running');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('Delete on a session page is disabled while a reply runs, and a refused delete says why', async ({ page }) => {
    const origin = { 'X-CC': '1', Origin: `http://127.0.0.1:${E2E_PORT}` };
    const { id } = await startSlowSession(page);
    try {
      await page.request.post(`/api/sessions/${id}/cancel`, { headers: origin });
      await expect.poll(() => sessionStatus(page, id), { timeout: 10_000 }).toBe('cancelled');
      await page.goto(`/sessions/${id}`);
      const panel = page.locator(`[data-session-id="${id}"]`);
      const del = page.getByRole('button', { name: 'Delete', exact: true });
      await expect(panel.getByText('cancelled', { exact: true })).toBeVisible();
      await expect(del).toBeEnabled();
      await panel.getByLabel('Reply to the session').fill('Calibrate again, slowly');
      await panel.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(panel.getByText('running', { exact: true })).toBeVisible({ timeout: 10_000 });
      await expect(del).toBeDisabled();
      await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(panel.getByText('cancelled', { exact: true })).toBeVisible({ timeout: 10_000 });
      await expect(del).toBeEnabled();
      await page.route(`**/api/sessions/${id}`, (route) => (route.request().method() === 'DELETE' ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: `session ${id} is still running` }) }) : route.fallback()));
      await del.click();
      await page.getByRole('dialog', { name: 'Delete this session?' }).getByRole('button', { name: 'Delete' }).click();
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: `Could not delete the session: session ${id} is still running` })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toContainText(id);
    } finally {
      await page.unrouteAll();
      await page.request.post(`/api/sessions/${id}/cancel`, { headers: origin });
    }
  });

  test('a Cancel the server refuses says so on the session page and on the Runs page', async ({ page }) => {
    const { id, runId } = await startSlowSession(page);
    try {
      await page.route('**/api/sessions/*/cancel', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'cancel refused for the test' }) }));
      await page.route('**/api/runs/*/cancel', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'cancel refused for the test' }) }));
      await page.goto(`/sessions/${id}`);
      const panel = page.locator(`[data-session-id="${id}"]`);
      await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText('Could not cancel: cancel refused for the test');
      await page.goto('/runs');
      await runningRow(page).getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.locator('p[role="alert"]')).toHaveText(`Could not cancel ${runId}: cancel refused for the test`);
      // The page message sits above the table, so a toast says it where the user is looking too.
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: `Could not cancel ${runId}: cancel refused for the test` })).toBeVisible();
    } finally {
      await page.unrouteAll();
      await page.request.post(`/api/sessions/${id}/cancel`, { headers: { 'X-CC': '1', Origin: `http://127.0.0.1:${E2E_PORT}` } });
    }
  });
});

test.describe('Sessions list filters (R8-21)', () => {
  test.beforeEach(async ({ page }) => login(page));

  test('a filter that hides every session says no session matches, not that there are none yet', async ({ page }) => {
    const stamp = '2026-10-05T12:00:00.000Z';
    const session = { id: 'e2e-filter-done', claudeSessionId: '44444444-4444-4444-8444-444444444444', mode: 'deep', policyClass: 'research', target: { type: 'app', value: '1' }, model: null, status: 'done', createdAt: stamp, updatedAt: stamp, turns: [], totals: { costUsd: 0, tokens: 0 }, filesChanged: [], reportNum: null, policyVersion: 2 };
    await page.route('**/api/sessions', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([session]) }));
    await page.goto('/sessions');
    await expect(page.getByRole('row').filter({ hasText: 'deep' })).toHaveCount(1);
    await page.getByLabel('Filter by status').selectOption('error');
    await expect(page.getByText('No sessions match the filters.')).toBeVisible();
    await expect(page.getByText(/No sessions yet/)).toHaveCount(0);
    await axeClean(page);
  });
});

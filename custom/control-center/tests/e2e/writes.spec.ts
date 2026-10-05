import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { axeBuilder } from './helpers.js';
import { E2E_TOKEN } from '../../playwright.config.js';

async function login(page: Page) {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

test.describe('deterministic writes from the pages', () => {
  test.beforeEach(async ({ page }) => login(page));

  test('cv.md changed on disk while its editor holds unsaved edits: the editor says so and Save gets the conflict, never overwriting it', async ({ page }) => {
    // The e2e roots sit under CC_E2E_TMP (playwright.config.ts): root/ is the main app's data root.
    const cv = path.join(process.env.CC_E2E_TMP!, 'root', 'cv.md');
    const original = fs.readFileSync(cv, 'utf8');
    try {
      await page.goto('/profile');
      const editor = page.getByLabel('cv.md contents');
      await expect(editor).toHaveValue(original);
      await editor.fill(`${original}\n- typed in the editor\n`);
      // Another writer (an "Add an entry" session, or a shell) changes the file; the watcher refreshes the page's data.
      fs.appendFileSync(cv, '\n- added elsewhere\n');
      await expect(page.getByRole('alert')).toContainText('cv.md changed on disk since you started editing', { timeout: 15_000 });
      await expect(editor).toHaveValue(`${original}\n- typed in the editor\n`);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Current version on disk')).toBeVisible();
      await expect(page.locator('pre', { hasText: '- added elsewhere' })).toBeVisible();
      expect(fs.readFileSync(cv, 'utf8')).toBe(`${original}\n- added elsewhere\n`);
    } finally {
      fs.writeFileSync(cv, original);
    }
  });

  test('Import CV: Save as cv.md through a link that leads outside the data root shows why it was refused and writes nothing', async ({ page }) => {
    const root = path.join(process.env.CC_E2E_TMP!, 'root');
    const cv = path.join(root, 'cv.md');
    const original = fs.readFileSync(cv, 'utf8');
    const outside = path.join(process.env.CC_E2E_TMP!, 'outside-cv.md');
    fs.writeFileSync(outside, '# Shared elsewhere\n');
    fs.rmSync(cv);
    fs.symlinkSync(outside, cv);
    try {
      await page.goto('/profile');
      await page.getByLabel('CV markdown').fill('# Jane Candidate\n\nPlatform engineer.');
      await page.getByRole('button', { name: 'Save as cv.md' }).click();
      await expect(page.getByRole('alert')).toContainText(/Could not save cv\.md: .*outside the data root; nothing was written/);
      await expect(page.getByText('cv.md saved.')).toHaveCount(0);
      expect(fs.readFileSync(outside, 'utf8')).toBe('# Shared elsewhere\n');
    } finally {
      fs.rmSync(cv, { force: true });
      fs.writeFileSync(cv, original);
      fs.rmSync(outside, { force: true });
    }
  });

  test('inbox Skip flips the pipeline checkbox, Undo restores it, and Add URLs appends a row', async ({ page }) => {
    await page.goto('/pipeline');
    const row = page.getByRole('row', { name: /Soylent Foods/ });
    await row.getByRole('button', { name: /Skip Soylent Foods/ }).click();
    await expect(page.getByRole('row', { name: /Soylent Foods/ })).toHaveCount(0);
    await page.getByLabel('Show skipped').check();
    await page.getByRole('button', { name: /Restore Soylent Foods/ }).click();
    await expect(page.getByRole('row', { name: /Soylent Foods/ }).getByRole('button', { name: /Skip Soylent Foods/ })).toBeVisible();
    await page.getByRole('button', { name: 'Add URLs' }).click();
    await page.getByLabel('Posting URLs').fill('https://jobs.example.com/e2e/1');
    await page.getByRole('button', { name: 'Add to pipeline' }).click();
    await expect(page.getByRole('status')).toHaveText(/Added 1 URL/);
    await expect(page.getByRole('link', { name: 'https://jobs.example.com/e2e/1' })).toBeVisible();
  });

  test('Follow-ups page logs a follow-up and pins a date', async ({ page }) => {
    await page.goto('/followups');
    // Acme (#1) stays Applied across the suite; Vandelay is discarded by actions.spec and leaves the cadence.
    await page.getByRole('button', { name: 'Log follow-up for Acme Robotics' }).click();
    await page.getByLabel('Notes').fill('e2e note');
    await page.getByRole('button', { name: 'Save follow-up' }).click();
    await expect(page.getByRole('status')).toHaveText(/Logged follow-up #3/);
    await page.getByRole('button', { name: 'Pin next follow-up for Acme Robotics in 7 days' }).click();
    await expect(page.getByRole('status')).toHaveText(/pinned to/);
    const detail = await (await page.request.get('/api/tracker/1')).json();
    expect(detail.timeline.pin).not.toBeNull();
    expect(detail.timeline.followups.some((f: { notes: string }) => f.notes === 'e2e note')).toBe(true);
  });

  test('Application Documents tab lists PDFs with Re-render and the danger zone previews a delete', async ({ page }) => {
    await page.goto('/tracker/1');
    await page.getByRole('tab', { name: 'Documents' }).click();
    await expect(page.getByRole('link', { name: 'output/acme-robotics-cv.pdf' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Re-render from HTML/ })).toBeVisible();
    await page.getByRole('button', { name: 'Preview delete (dry run)' }).click();
    await expect(page.getByLabel('Delete preview')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm delete #1' })).toBeVisible();
    const tracker = await (await page.request.get('/api/tracker')).json();
    expect(tracker.rows.some((r: { num: number }) => r.num === 1)).toBe(true);
    const axe = await (await axeBuilder(page)).analyze();
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  });

  test("a delete preview made on one row does not arm the delete of the row Back returns to", async ({ page }) => {
    // Row #1 links to #3 as another application at the same company, so the move from #1 to #3 stays inside the app.
    await page.route('**/api/tracker/1', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { companyHistory: unknown[] };
      await route.fulfill({ response: res, json: { ...body, companyHistory: [{ num: 3, role: 'Staff Software Engineer', status: 'Interview', date: '2026-09-25' }] } });
    });
    await page.goto('/tracker/1');
    await expect(page.getByRole('heading', { level: 1, name: 'Acme Robotics' })).toBeVisible();
    await page.getByRole('tab', { name: 'Timeline' }).click();
    await page.getByRole('link', { name: '#3 Staff Software Engineer' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Globex Payments' })).toBeVisible();
    await page.getByRole('tab', { name: 'Documents' }).click();
    await page.getByRole('button', { name: 'Preview delete (dry run)' }).click();
    await expect(page.getByRole('button', { name: 'Confirm delete #3' })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: 'Acme Robotics' })).toBeVisible();
    await page.getByRole('tab', { name: 'Documents' }).click();
    await expect(page.getByRole('button', { name: 'Preview delete (dry run)' })).toBeVisible();
    await expect(page.getByLabel('Delete preview')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Confirm delete #1' })).toHaveCount(0);
  });

  test('Network scan Add all sends every result, in bodies the pipeline route accepts, and says how many were added', async ({ page }) => {
    // The scan run and the pipeline write are answered here: the route's own limits are covered by the writes API tests.
    const postings = Array.from({ length: 205 }, (_, i) => ({ url: `https://boards.example.com/bulk/${i}`, company: `Bulk ${i}`, title: 'Platform Engineer', location: i === 0 ? null : i === 1 ? 'Office '.repeat(40).trim() : 'Remote', postedAt: null, source: 'greenhouse' }));
    const summary = { line: JSON.stringify({ postings, capHit: false, stoppedEarly: false }), stream: 'stdout', seq: 1, ts: '2026-10-05T12:00:00.000Z' };
    await page.route('**/api/actions/scan.network', (route) => route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ runId: 'e2e-network-scan' }) }));
    await page.route('**/api/runs/e2e-network-scan/events', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: line\ndata: ${JSON.stringify(summary)}\n\nevent: run.done\ndata: {"status":"done"}\n\n` }));
    const bodies: Array<{ offers: Array<Record<string, unknown>> }> = [];
    await page.route('**/api/pipeline/add', async (route) => {
      const body = route.request().postDataJSON() as { offers: Array<Record<string, unknown>> };
      bodies.push(body);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ added: body.offers.length, skipped: 0 }) });
    });
    await page.goto('/discover');
    await page.getByRole('button', { name: /Run network scan/ }).click();
    await page.getByRole('button', { name: 'Add all (205)' }).click();
    await expect(page.getByText('Added 205 to the pipeline')).toBeVisible();
    expect(bodies.map((b) => b.offers.length)).toEqual([200, 5]);
    const sent = bodies.flatMap((b) => b.offers);
    expect(sent.map((o) => o.url)).toEqual(postings.map((p) => p.url));
    expect(sent[0]).not.toHaveProperty('location');
    expect(String(sent[1]!.location).length).toBeLessThanOrEqual(200);
  });

  test('Network scan Add all that fails part way says how many were added before the failure, and a retry says what was already there', async ({ page }) => {
    const postings = Array.from({ length: 205 }, (_, i) => ({ url: `https://boards.example.com/partial/${i}`, company: `Partial ${i}`, title: 'Platform Engineer', location: 'Remote', postedAt: null, source: 'greenhouse' }));
    const summary = { line: JSON.stringify({ postings }), stream: 'stdout', seq: 1, ts: '2026-10-05T12:00:00.000Z' };
    await page.route('**/api/actions/scan.network', (route) => route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ runId: 'e2e-network-scan-2' }) }));
    await page.route('**/api/runs/e2e-network-scan-2/events', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: line\ndata: ${JSON.stringify(summary)}\n\nevent: run.done\ndata: {"status":"done"}\n\n` }));
    // The route is idempotent: on the retry the first batch is already in the pipeline and comes back skipped.
    const answers = [
      { status: 200, body: { added: 200, skipped: 0 } },
      { status: 409, body: { error: 'pipeline is busy, try again in a moment' } },
      { status: 200, body: { added: 0, skipped: 200 } },
      { status: 200, body: { added: 5, skipped: 0 } },
    ];
    await page.route('**/api/pipeline/add', async (route) => {
      const a = answers.shift()!;
      await route.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.body) });
    });
    await page.goto('/discover');
    await page.getByRole('button', { name: /Run network scan/ }).click();
    await page.getByRole('button', { name: 'Add all (205)' }).click();
    await expect(page.getByText('Added 200, then could not add the rest: pipeline is busy, try again in a moment')).toBeVisible();
    await page.getByRole('button', { name: 'Add all (205)' }).click();
    await expect(page.getByText('Added 5 to the pipeline; 200 were already there')).toBeVisible();
    expect(answers).toEqual([]);
  });

  test('Discover renders the network scan form and the Fresh tab', async ({ page }) => {
    await page.goto('/discover');
    await expect(page.getByRole('heading', { level: 1, name: 'Discover' })).toBeVisible();
    await expect(page.getByRole('form', { name: 'Network scan filters' })).toBeVisible();
    const sources = page.getByRole('group', { name: 'ATS sources' }).getByRole('checkbox');
    await expect(sources).toHaveCount(6);
    expect(await sources.evaluateAll((boxes) => boxes.map((b) => b.closest('label')!.textContent!.trim()))).toEqual(['greenhouse', 'lever', 'ashby', 'workday', 'icims', 'bamboohr']);
    await page.getByRole('tab', { name: 'Fresh' }).click();
    await expect(page).toHaveURL(/tab=fresh/);
    await expect(page.getByRole('table', { name: 'Fresh matches' })).toBeVisible();
    const axe = await (await axeBuilder(page)).analyze();
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  });
});

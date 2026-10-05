import { test, expect, type Page } from '@playwright/test';
import { E2E_PORT, E2E_TOKEN } from '../../playwright.config.js';

test.describe('deterministic writes through the action registry', () => {
  test('changing a status from the tracker preview runs set-status and the ledger records source web', async ({ page }) => {
    await page.goto(`/auth?t=${E2E_TOKEN}`);
    await page.goto('/tracker');
    await page.getByRole('row', { name: /Northwind Analytics/ }).click();
    const control = page.getByLabel('Change status');
    await expect(control).toHaveValue('Evaluated');
    await control.selectOption('Applied');
    await expect(page.getByRole('status')).toHaveText('Status set to Applied');
    await expect(page.getByRole('row', { name: /Northwind Analytics/ }).getByText('Applied')).toBeVisible();
    const tracker = await (await page.request.get('/api/tracker')).json();
    expect(tracker.rows.find((r: { num: number }) => r.num === 2).status).toBe('Applied');
    const detail = await (await page.request.get('/api/tracker/2')).json();
    expect(detail.timeline.statusLog.at(-1)).toMatchObject({ from: 'Evaluated', to: 'Applied', source: 'web' });
  });

  test('Discarded asks for a reason and commits it as a DISCARD note', async ({ page }) => {
    await page.goto(`/auth?t=${E2E_TOKEN}`);
    await page.goto('/tracker');
    await page.getByRole('row', { name: /Vandelay Systems/ }).click();
    await page.getByLabel('Change status').selectOption('Discarded');
    await page.getByLabel('Discard reason', { exact: true }).selectOption('level mismatch');
    await page.getByRole('button', { name: 'Confirm Discarded' }).click();
    await expect(page.getByRole('status')).toHaveText('Status set to Discarded');
    const detail = await (await page.request.get('/api/tracker/6')).json();
    expect(detail.row.status).toBe('Discarded');
    expect(detail.row.notes).toContain('DISCARD: level mismatch');
  });

  test('an Other reason typed key by key is saved whole as the DISCARD note', async ({ page }) => {
    await page.goto(`/auth?t=${E2E_TOKEN}`);
    await page.goto('/tracker');
    await page.getByRole('row', { name: /Umbrella Corp/ }).click();
    await page.getByLabel('Change status').selectOption('SKIP');
    await page.getByLabel('Discard reason', { exact: true }).selectOption('__other');
    await page.getByLabel('Other reason').pressSequentially('too far');
    await expect(page.getByLabel('Other reason')).toHaveValue('too far');
    await page.getByRole('button', { name: 'Confirm SKIP' }).click();
    await expect(page.getByRole('status')).toHaveText('Status set to SKIP');
    const detail = await (await page.request.get('/api/tracker/5')).json();
    expect(detail.row.status).toBe('SKIP');
    expect(detail.row.notes).toContain('DISCARD: too far');
  });

  test('Runs page starts a free script run, tails its log and shows it finished', async ({ page }) => {
    await page.goto(`/auth?t=${E2E_TOKEN}`);
    await page.goto('/runs');
    await expect(page.getByRole('heading', { level: 1, name: 'Runs & Schedule' })).toBeVisible();
    await page.getByRole('button', { name: /Run Prioritize pipeline/ }).click();
    await expect(page.getByRole('cell', { name: 'done' }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel('Run log')).toBeVisible();
    await expect(page.getByText('ended: done')).toBeVisible();
  });
});

test.describe('Today: shortlist and decisions act on the row', () => {
  const setStatus = (page: Page, row: number, state: string) =>
    page.request.post('/api/actions/tracker.setStatus', { data: { params: { row, state } }, headers: { 'x-cc': '1', origin: `http://127.0.0.1:${E2E_PORT}` } });

  test('Evaluate on a shortlist row starts an oferta session for its posting and opens it', async ({ page }) => {
    await page.goto(`/auth?t=${E2E_TOKEN}`);
    // The session itself is stubbed: a real oferta run here would merge a tracker row and reserve a report number other specs count on.
    let sent: unknown = null;
    await page.route('**/api/sessions', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      sent = route.request().postDataJSON();
      await route.fulfill({ status: 201, json: { id: 's-today-evaluate', mode: 'oferta', status: 'queued', turns: [] } });
    });
    await page.goto('/');
    const row = page.getByRole('row', { name: /Acme Robotics/ });
    await row.getByRole('button', { name: 'Evaluate' }).click();
    await expect(page).toHaveURL(/\/sessions\/s-today-evaluate$/);
    expect(sent).toMatchObject({ mode: 'oferta', target: { type: 'url', value: 'https://jobs.example.com/acme/123' }, prompt: 'Evaluate this job posting following the mode file: https://jobs.example.com/acme/123' });
  });

  test('Applied and Skip set the status, and Skip asks for a reason first', async ({ page }) => {
    await page.goto(`/auth?t=${E2E_TOKEN}`);
    // The specs above left #2 Applied and #6 Discarded; both wait for a decision again here, and #6 goes back to Discarded after.
    expect((await setStatus(page, 2, 'Evaluated')).status()).toBe(200);
    expect((await setStatus(page, 6, 'Evaluated')).status()).toBe(200);
    try {
      await page.goto('/');
      const decisions = page.getByRole('list', { name: 'Decisions' });
      const northwind = decisions.getByRole('listitem').filter({ hasText: 'Northwind Analytics' });
      await northwind.getByRole('button', { name: 'Applied' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Northwind Analytics: status set to Applied' })).toBeVisible();
      await expect(northwind).toHaveCount(0);
      expect((await (await page.request.get('/api/tracker/2')).json()).row.status).toBe('Applied');

      const vandelay = decisions.getByRole('listitem').filter({ hasText: 'Vandelay Systems' });
      await vandelay.getByRole('button', { name: 'Skip' }).click();
      const picker = page.getByRole('dialog', { name: 'Discard reason picker' });
      await expect(picker).toContainText('Why skip this one?');
      await expect(picker.getByRole('button', { name: 'Confirm SKIP' })).toBeDisabled();
      await picker.getByLabel('Discard reason', { exact: true }).selectOption('location mismatch');
      await picker.getByRole('button', { name: 'Confirm SKIP' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Vandelay Systems: status set to SKIP' })).toBeVisible();
      const detail = await (await page.request.get('/api/tracker/6')).json();
      expect(detail.row.status).toBe('SKIP');
      expect(detail.row.notes).toContain('DISCARD: location mismatch');
    } finally {
      expect((await setStatus(page, 6, 'Discarded')).status()).toBe(200);
    }
  });
});

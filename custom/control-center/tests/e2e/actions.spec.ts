import { test, expect } from '@playwright/test';
import { E2E_TOKEN } from '../../playwright.config.js';

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

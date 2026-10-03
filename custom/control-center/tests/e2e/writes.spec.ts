import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { E2E_TOKEN } from '../../playwright.config.js';

async function login(page: Page) {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

test.describe('deterministic writes from the pages', () => {
  test.beforeEach(async ({ page }) => login(page));

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
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  });

  test('Discover renders the network scan form and the Fresh tab', async ({ page }) => {
    await page.goto('/discover');
    await expect(page.getByRole('heading', { level: 1, name: 'Discover' })).toBeVisible();
    await expect(page.getByRole('form', { name: 'Network scan filters' })).toBeVisible();
    await page.getByRole('tab', { name: 'Fresh' }).click();
    await expect(page).toHaveURL(/tab=fresh/);
    await expect(page.getByRole('table', { name: 'Fresh matches' })).toBeVisible();
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  });
});

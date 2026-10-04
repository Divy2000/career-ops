import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { E2E_TOKEN } from '../../playwright.config.js';

async function login(page: Page) {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

async function axeClean(page: Page) {
  const axe = await new AxeBuilder({ page }).analyze();
  const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
}

test.describe('Sponsorship > Lookup', () => {
  test.beforeEach(async ({ page }) => login(page));

  test('looks up a company: DOL record, freshness, saved file and a started check session', async ({ page }) => {
    await page.goto('/sponsorship?tab=lookup');
    await expect(page.getByRole('tab', { name: 'Lookup' })).toHaveAttribute('aria-selected', 'true');
    await page.getByLabel('Company name').fill('Acme Robotics');
    await page.getByRole('button', { name: 'Look up' }).click();
    await expect(page).toHaveURL(/q=Acme(\+|%20)Robotics/);
    await expect(page.getByRole('heading', { name: 'Acme Robotics, Inc.' })).toBeVisible();
    await expect(page.getByText('sponsor: strong')).toBeVisible();
    await expect(page.getByText('LCAs filed').locator('..').getByText('412')).toBeVisible();
    await expect(page.getByText('Certified', { exact: true }).locator('..').getByText('398')).toBeVisible();
    await expect(page.getByText('Green cards').locator('..').getByText('yes')).toBeVisible();
    await expect(page.getByText('h1b-index:fake-2026Q3')).toBeVisible();
    const fresh = page.getByRole('heading', { name: 'Saved check freshness' }).locator('..');
    await expect(fresh.getByText('2026-09-28')).toBeVisible();
    await expect(page.getByText('120 approvals in the latest DOL disclosure')).toBeVisible();
    await expect(page.getByText('No company alerts match this name.')).toBeVisible();
    await axeClean(page);
    await page.getByRole('button', { name: /Run sponsorship check/ }).click();
    await expect(page.getByText('Sponsorship check complete for Northwind Analytics')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('link', { name: 'Open session' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sessions', exact: true }).last()).toHaveAttribute('href', '/sessions');
  });

  test('shows the staffing-shop red flag with its share and the matching company alerts', async ({ page }) => {
    await page.goto('/sponsorship?tab=lookup&q=Vandelay%20Staffing%20Solutions%20LLC');
    await expect(page.getByText('sponsor: staffing-shop')).toBeVisible();
    await expect(page.getByText('Staffing-shop red flag.')).toBeVisible();
    await expect(page.getByText('82% of filings are at secondary worksites')).toBeVisible();
    await page.goto('/sponsorship?tab=lookup&q=Globex%20Payments');
    await expect(page.getByRole('link', { name: 'Globex resumes sponsorship after fee review' })).toBeVisible();
  });

  test('search names lists DOL entities and each opens an exact lookup', async ({ page }) => {
    await page.goto('/sponsorship?tab=lookup');
    await page.getByLabel('Company name').fill('JPMorganChase');
    await page.getByRole('button', { name: 'Look up' }).click();
    await expect(page.getByText('No DOL sponsor record for "JPMorganChase".')).toBeVisible();
    await page.getByLabel('Company name').fill('JPMorgan');
    await page.getByRole('button', { name: 'Search names' }).click();
    await expect(page).toHaveURL(/mode=search/);
    await expect(page.getByRole('heading', { name: '2 entities match "JPMorgan"' })).toBeVisible();
    await axeClean(page);
    await page.getByRole('link', { name: 'JPMorgan Chase & Co.' }).click();
    await expect(page.getByRole('heading', { name: 'JPMorgan Chase & Co.', level: 2 })).toBeVisible();
    await expect(page.getByText('sponsor: strong')).toBeVisible();
  });

  test('not found offers a name search; an unknown name still shows no fake data', async ({ page }) => {
    await page.goto('/sponsorship?tab=lookup&q=Zzz%20Nonexistent%20Holdings');
    await expect(page.getByText('No DOL sponsor record for "Zzz Nonexistent Holdings".')).toBeVisible();
    await expect(page.getByText('No saved check for this company yet.')).toBeVisible();
    await page.getByRole('link', { name: 'Search names for Zzz Nonexistent Holdings' }).click();
    await expect(page.getByRole('heading', { name: 'No DOL entities match "Zzz Nonexistent Holdings"' })).toBeVisible();
    await axeClean(page);
  });

  test('a missing index shows the install command as text and nothing runs it', async ({ page }) => {
    await page.goto('/sponsorship?tab=lookup&q=Index%20Missing%20Probe');
    await expect(page.getByText('The local H-1B index is not installed.')).toBeVisible();
    await expect(page.getByText('node plugins/h1b-sponsor/install-h1b-index.mjs', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /install/i })).toHaveCount(0);
    await page.goto('/sponsorship?tab=lookup&q=Index%20Missing%20Probe&mode=search');
    await expect(page.getByText('node plugins/h1b-sponsor/install-h1b-index.mjs', { exact: true })).toBeVisible();
  });

  test('the form rejects an empty name and a dash-led name before any request', async ({ page }) => {
    let calls = 0;
    page.on('request', (r) => r.url().includes('/api/sponsorship/') && calls++);
    await page.goto('/sponsorship?tab=lookup');
    await page.getByRole('button', { name: 'Look up' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'a company name is required' })).toBeVisible();
    await page.getByLabel('Company name').fill('--refresh');
    await page.getByRole('button', { name: 'Search names' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'must not start with a dash' })).toBeVisible();
    expect(calls).toBe(0);
  });
});

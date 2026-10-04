import { test, expect, type Page } from '@playwright/test';
import { axeBuilder } from './helpers.js';
import { E2E_TOKEN } from '../../playwright.config.js';

async function login(page: Page) {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

async function axeClean(page: Page) {
  const axe = await (await axeBuilder(page)).analyze();
  const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
}

test.describe('read-only pages render fixture data', () => {
  test.beforeEach(async ({ page }) => login(page));

  test('Today shows the shortlist, the failed daily job, policy bullets and fresh matches', async ({ page }) => {
    await expect(page.getByText('Daily job 2026-10-03: failed')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Globex Payments' })).toBeVisible();
    await expect(page.getByText('Proposed rule on a new petition fee')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Fresh matches this week' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Decisions' })).toBeVisible();
    await expect(page.getByText('Northwind Analytics').first()).toBeVisible();
    await axeClean(page);
  });

  test('Tracker lists rows, filters by tab and search, previews and opens an application', async ({ page }) => {
    await page.getByRole('link', { name: 'Tracker' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tracker' })).toBeVisible();
    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(6);
    await page.getByRole('tab', { name: /^Interview/ }).click();
    await expect(rows).toHaveCount(1);
    await expect(page).toHaveURL(/tab=interview/);
    await page.getByRole('tab', { name: /^All/ }).click();
    await page.getByLabel('Search tracker').fill('vandelay');
    await expect(rows).toHaveCount(1);
    await page.getByLabel('Search tracker').fill('');
    await page.getByRole('button', { name: /^Score/ }).click();
    await expect(page.locator('th[aria-sort="ascending"]')).toHaveCount(1);
    await rows.first().click();
    await expect(page.getByRole('complementary', { name: 'Preview' }).getByText('TL;DR')).toBeVisible();
    await page.getByRole('button', { name: 'Flat list' }).click();
    await expect(page.locator('.group-row')).not.toHaveCount(0);
    await axeClean(page);
    await page.getByRole('link', { name: 'Open Acme Robotics' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Acme Robotics' })).toBeVisible();
  });

  test('Application shows the verdict, report sections, timeline and sponsorship', async ({ page }) => {
    await page.goto('/tracker/1');
    await expect(page.getByRole('heading', { level: 1, name: 'Acme Robotics' })).toBeVisible();
    await expect(page.getByText('At or above the 4.0 apply line')).toBeVisible();
    await expect(page.getByText('Recommendation: Apply')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'A) Role Summary' })).toBeVisible();
    await expect(page.getByText('sponsor: strong')).toBeVisible();
    await axeClean(page);
    await page.getByRole('tab', { name: 'Timeline' }).click();
    await expect(page.getByRole('heading', { name: 'Status log' })).toBeVisible();
    await expect(page.getByText('asked about timeline')).toBeVisible();
    await expect(page.getByText('Next pinned to')).toBeVisible();
    await page.goto('/tracker/4');
    await expect(page.getByText('Discard reasons: comp below floor, staffing agency')).toBeVisible();
    await page.goto('/tracker/5');
    await expect(page.getByText('This row has no report linked.')).toBeVisible();
  });

  test('Pipeline inbox and shortlist tabs', async ({ page }) => {
    await page.goto('/pipeline');
    await expect(page.getByRole('heading', { level: 1, name: 'Pipeline' })).toBeVisible();
    await expect(page.getByText('Soylent Foods')).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(4);
    await page.getByLabel('Show skipped').check();
    await expect(page.locator('tbody tr')).toHaveCount(6);
    await axeClean(page);
    await page.getByRole('tab', { name: 'Shortlist' }).click();
    await expect(page).toHaveURL(/tab=shortlist/);
    await expect(page.getByText('Initech pauses visa sponsorship for new hires')).toBeVisible();
  });

  test('Sponsorship tabs', async ({ page }) => {
    await page.goto('/sponsorship');
    await expect(page.getByRole('heading', { level: 1, name: 'Sponsorship' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '2026-10-02' })).toBeVisible();
    const watcher = page.getByRole('heading', { name: 'Watcher state' }).locator('..');
    await expect(watcher.getByText('Last run')).toBeVisible();
    await expect(watcher.getByText('Items seen')).toBeVisible();
    await expect(watcher.getByText('"ids"')).toBeHidden();
    await watcher.getByText('Raw seen.json').click();
    await expect(watcher.getByText('"ids"')).toBeVisible();
    await page.getByRole('tab', { name: /Company alerts/ }).click();
    await expect(page.getByRole('link', { name: 'Initech pauses visa sponsorship for new hires' })).toBeVisible();
    await page.getByRole('tab', { name: /Company checks/ }).click();
    await expect(page.getByRole('cell', { name: 'Acme Robotics' })).toBeVisible();
    await axeClean(page);
  });

  test('Insights overview, progress and breakdown', async ({ page }) => {
    await page.goto('/insights');
    await expect(page.getByRole('heading', { level: 1, name: 'Insights' })).toBeVisible();
    await expect(page.getByText('Average score').locator('..').getByText('3.9')).toBeVisible();
    await page.getByRole('tab', { name: 'Progress' }).click();
    await expect(page.getByRole('heading', { name: 'Funnel' })).toBeVisible();
    await expect(page.getByText('Applied to interview')).toBeVisible();
    await page.getByRole('tab', { name: 'Breakdown' }).click();
    await expect(page.getByRole('heading', { name: 'Archetypes' })).toBeVisible();
    await axeClean(page);
  });

  test('Follow-ups cadence table', async ({ page }) => {
    await page.goto('/followups');
    await expect(page.getByRole('heading', { level: 1, name: 'Follow-ups' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'overdue' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Globex Payments' })).toBeVisible();
    await axeClean(page);
  });
});

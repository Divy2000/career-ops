import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { axeBuilder } from './helpers.js';
import { E2E_TOKEN, EMPTY_ROOT } from '../../playwright.config.js';

// Runs against an app whose data root has a header-only tracker: the normal first launch.
const HEADER_ONLY = fs.readFileSync(path.join(EMPTY_ROOT, 'data', 'applications.md'), 'utf8');

async function login(page: Page) {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

async function settled(page: Page) {
  await expect(page.locator('.skeleton')).toHaveCount(0);
}

async function noErrorBanners(page: Page) {
  await expect(page.getByText('Could not load.')).toHaveCount(0);
  await expect(page.getByText('File malformed.')).toHaveCount(0);
  await expect(page.locator('.card--danger')).toHaveCount(0);
}

for (const [name, arrange] of [
  ['a header-only tracker', () => fs.writeFileSync(path.join(EMPTY_ROOT, 'data', 'applications.md'), HEADER_ONLY)],
  ['no tracker file', () => fs.rmSync(path.join(EMPTY_ROOT, 'data', 'applications.md'), { force: true })],
] as const) {
  test.describe(`empty tracker: ${name}`, () => {
    test.beforeEach(async ({ page }) => {
      arrange();
      await login(page);
    });

    test('Follow-ups shows an empty state, not an error', async ({ page }) => {
      await page.goto('/followups');
      await expect(page.getByRole('heading', { level: 1, name: 'Follow-ups' })).toBeVisible();
      await expect(page.getByText('No applications in follow-up cadence yet.')).toBeVisible();
      await noErrorBanners(page);
      await (await axeBuilder(page)).analyze().then((axe) => expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]));
    });

    test('Today points a new user at the first step and its Follow-ups card says nothing is due', async ({ page }) => {
      await settled(page);
      await expect(page.getByRole('heading', { name: 'Start with your CV' })).toBeVisible();
      await expect(page.getByText('Nothing due.')).toBeVisible();
      await noErrorBanners(page);
    });

    test('Tracker shows "No applications yet" with a next action', async ({ page }) => {
      await page.getByRole('link', { name: 'Tracker' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Tracker' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'No applications yet' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Evaluate a job on Today' })).toBeVisible();
      await noErrorBanners(page);
    });

    test('Insights shows the empty state on the dashboard and on every script tab', async ({ page }) => {
      await page.goto('/insights');
      await expect(page.getByRole('heading', { name: 'No applications yet' })).toBeVisible();
      await noErrorBanners(page);
      for (const tab of ['Funnel velocity', 'Patterns', 'Salary', 'Skills', 'Reposts & legitimacy']) {
        await page.getByRole('tab', { name: tab }).click();
        await settled(page);
        await expect(page.getByText(/The script exited/)).toHaveCount(0);
        await noErrorBanners(page);
      }
      await page.getByRole('tab', { name: 'Patterns' }).click();
      await expect(page.getByText('No applications found in tracker.')).toBeVisible();
      await expect(page.locator('dt', { hasText: 'noData' })).toHaveCount(0);
    });
  });
}

test.describe('no tutorials', () => {
  test('Tutorials explains the folder and the manifest format instead of showing an error', async ({ page }) => {
    await login(page);
    await page.goto('/tutorials');
    await expect(page.getByRole('heading', { level: 1, name: 'Tutorials' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No tutorials yet' })).toBeVisible();
    await expect(page.getByText('data/control-center/tutorials/', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('"chapters": [', { exact: false })).toBeVisible();
    await expect(page.getByText('install-tutorial.mjs', { exact: false })).toBeVisible();
    await expect(page.locator('video')).toHaveCount(0);
    await settled(page);
    await noErrorBanners(page);
    await (await axeBuilder(page)).analyze().then((axe) => expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]));
  });
});

test.describe('a daily run that never wrote its done line', () => {
  const unfinished = path.join(EMPTY_ROOT, 'data', 'immigration', 'logs', '2026-10-05.log');
  test.beforeEach(() => fs.writeFileSync(unfinished, '=== 2026-10-05 08:00:00 start\nERROR: Keychain item missing\n'));
  test.afterEach(() => fs.rmSync(unfinished, { force: true }));

  test('Today, the header chip and the log browser say interrupted, not ok or running, once the job is not running', async ({ page }) => {
    await login(page);
    await expect(page.getByText('Daily job 2026-10-05: interrupted')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Daily job 2026-10-05: interrupted' })).toBeVisible();
    await page.goto('/runs');
    const logs = page.locator('[aria-labelledby="log-browser-heading"]');
    await expect(logs.getByLabel('Log date')).toHaveValue('2026-10-05');
    await expect(logs.getByText('interrupted', { exact: true })).toBeVisible();
    await expect(logs.getByText('2026-10-05 08:00:00 to n/a')).toBeVisible();
  });
});

import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { E2E_TOKEN } from '../../playwright.config.js';

test.describe('Settings', () => {
  test('portals editor validates before writing, rejects a broken file and saves a good one', async ({ page }) => {
    await page.goto(`/auth?t=${E2E_TOKEN}`);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    const editor = page.getByLabel('portals.yml YAML');
    await expect(editor).toContainText('title_filter');
    const original = await editor.inputValue();
    await editor.fill('title_filter: [broken');
    await page.getByRole('button', { name: 'Validate and save' }).click();
    await expect(page.getByRole('alert')).toContainText('rejected the file');
    const unchanged = await (await page.request.get('/api/config/portals')).json();
    expect(unchanged.raw).toBe(original);
    await editor.fill(`# saved from the Control Center\n${original}`);
    await page.getByRole('button', { name: 'Validate and save' }).click();
    await expect(page.getByRole('status')).toContainText('Saved portals.yml');
    const saved = await (await page.request.get('/api/config/portals')).json();
    expect(saved.raw.startsWith('# saved from the Control Center')).toBe(true);
    await page.getByRole('tab', { name: 'AI engine' }).click();
    await expect(page.getByText('unprobed: Apply drafts answers only')).toBeVisible();
    await page.getByRole('tab', { name: 'Updates' }).click();
    await expect(page.getByRole('link', { name: 'Latest upstream-sync PR' })).toHaveAttribute('href', /Divy2000\/career-ops\/pulls/);
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  });
});

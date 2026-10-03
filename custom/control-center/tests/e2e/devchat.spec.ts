import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { E2E_TOKEN } from '../../playwright.config.js';

test.describe('Dev Chat', () => {
  test('a fake Dev Chat turn shows per-turn diffs, revert restores the bytes, and out-of-scope writes are denied', async ({ page }) => {
    await page.goto(`/auth?t=${E2E_TOKEN}`);
    await page.goto('/dev');
    await expect(page.getByRole('heading', { level: 1, name: 'Dev Chat' })).toBeVisible();
    await expect(page.getByText('Server reload')).toBeVisible();
    await page.getByLabel('Prompt for devchat').fill('Add a scoring rule');
    await page.getByRole('button', { name: 'Send', exact: true }).first().click();
    await expect(page.getByText('Blacklist and supervisor writes were blocked as expected.')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Permission denied')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Turn 1' })).toBeVisible();
    await expect(page.getByText('modes/_custom.md').first()).toBeVisible();
    await expect(page.getByText('data/notes/devchat.md').first()).toBeVisible();
    const custom = await (await page.request.get('/api/files/user/customMd')).json();
    expect(custom.text).toContain('Added by Dev Chat');
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
    await page.getByRole('button', { name: 'Revert turn' }).click();
    await page.getByRole('dialog', { name: 'Revert turn 1?' }).getByRole('button', { name: 'Revert' }).click();
    await expect(page.getByText(/^Reverted: /)).toBeVisible();
    const restored = await (await page.request.get('/api/files/user/customMd')).json();
    expect(restored.text).not.toContain('Added by Dev Chat');
  });

  test('the supervisor serves the reload status and the recovery page behind the session cookie', async ({ page, request }) => {
    expect((await request.get('/__supervisor/status')).status()).toBe(401);
    await page.goto(`/auth?t=${E2E_TOKEN}`);
    const status = await page.request.get('/__supervisor/status');
    expect(status.status()).toBe(200);
    expect(await status.json()).toMatchObject({ state: 'idle' });
    const recovery = await page.request.get('/__recovery');
    expect(recovery.status()).toBe(200);
    expect(await recovery.text()).toContain('Control Center recovery');
    expect((await page.request.get('/__recovery', { headers: { host: 'evil.example:4399' } })).status()).toBe(403);
  });
});

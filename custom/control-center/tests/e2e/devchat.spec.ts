import { test, expect } from '@playwright/test';
import { axeBuilder } from './helpers.js';
import { E2E_PORT, E2E_TOKEN } from '../../playwright.config.js';

test.describe('Dev Chat', () => {
  test('a fake Dev Chat turn shows per-turn diffs, revert restores the bytes, and out-of-scope writes are denied', async ({ page }) => {
    await page.goto(`/auth?t=${E2E_TOKEN}`);
    await page.goto('/dev');
    await expect(page.getByRole('heading', { level: 1, name: 'Dev Chat' })).toBeVisible();
    await expect(page.getByText('Server reload')).toBeVisible();
    await page.getByLabel('Prompt for devchat').fill('Add a scoring rule');
    await page.getByRole('button', { name: 'Send', exact: true }).first().click();
    // Scoped to the transcript: the git diff panel can hold the same text when custom/ has uncommitted changes.
    await expect(page.locator('p', { hasText: 'Blacklist and supervisor writes were blocked as expected.' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Permission denied', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Turn 1' })).toBeVisible();
    await expect(page.getByText('modes/_custom.md').first()).toBeVisible();
    await expect(page.getByText('data/notes/devchat.md').first()).toBeVisible();
    const custom = await (await page.request.get('/api/files/user/customMd')).json();
    expect(custom.text).toContain('Added by Dev Chat');
    const axe = await (await axeBuilder(page)).analyze();
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
    // An edit made after the turn blocks the revert, and the page says why.
    const write = (text: string, etag: string) => page.request.put('/api/files/user/customMd', { data: { text }, headers: { 'if-match': etag, 'x-cc': '1', origin: `http://127.0.0.1:${E2E_PORT}` } });
    const edited = await write(`${custom.text}- A rule added after the turn.\n`, custom.etag);
    expect(edited.status()).toBe(200);
    await page.getByRole('button', { name: 'Revert turn' }).click();
    await page.getByRole('dialog', { name: 'Revert turn 1?' }).getByRole('button', { name: 'Revert' }).click();
    await expect(page.getByText(/Revert failed: modes\/_custom\.md changed after turn 1/)).toBeVisible();
    expect((await (await page.request.get('/api/files/user/customMd')).json()).text).toContain('A rule added after the turn.');
    expect((await write(custom.text, (await edited.json()).etag)).status()).toBe(200);
    await page.getByRole('button', { name: 'Revert turn' }).click();
    await page.getByRole('dialog', { name: 'Revert turn 1?' }).getByRole('button', { name: 'Revert' }).click();
    await expect(page.getByText(/^Reverted: /)).toBeVisible();
    const restored = await (await page.request.get('/api/files/user/customMd')).json();
    expect(restored.text).not.toContain('Added by Dev Chat');
  });

  test('a transcript taller than its box scrolls with the keyboard (axe: scrollable-region-focusable)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.goto(`/auth?t=${E2E_TOKEN}`);
    await page.goto('/dev');
    await page.getByLabel('Prompt for devchat').fill('Add a scoring rule for a short window');
    await page.getByRole('button', { name: 'Send', exact: true }).first().click();
    await expect(page.locator('p', { hasText: 'Blacklist and supervisor writes were blocked as expected.' })).toBeVisible({ timeout: 20_000 });
    const transcript = page.getByLabel('Transcript for devchat');
    await expect.poll(() => transcript.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await expect(transcript).toHaveAttribute('tabindex', '0');
    expect(await transcript.evaluate((el) => el.scrollTop)).toBe(0);
    await transcript.focus();
    await expect(transcript).toBeFocused();
    await page.keyboard.press('PageDown');
    await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const axe = await (await axeBuilder(page)).analyze();
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
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
    // Reverts need the app origin and X-CC, like every mutating API call (a page on another 127.0.0.1 port gets 403).
    const form = { sessionId: 'nope', turn: '1' };
    const origin = `http://127.0.0.1:${E2E_PORT}`;
    expect((await page.request.post('/__recovery/revert', { form })).status()).toBe(403);
    expect((await page.request.post('/__recovery/revert', { form, headers: { origin } })).status()).toBe(403);
    expect((await page.request.post('/__recovery/revert', { form, headers: { origin: 'http://127.0.0.1:4387', 'x-cc': '1' } })).status()).toBe(403);
    expect((await page.request.post('/__recovery/revert', { form, headers: { origin, 'x-cc': '1' } })).status()).toBe(404);
  });

  test('the recovery page reverts a Dev Chat turn through its own script', async ({ page }) => {
    await page.goto(`/auth?t=${E2E_TOKEN}`);
    // A known baseline without the scenario's line, whatever earlier tests left behind, so the revert is observable.
    const current = (await (await page.request.get('/api/files/user/customMd')).json()) as { text: string; etag: string };
    const preSession = current.text.replace('- Added by Dev Chat.\n', '');
    const origin = `http://127.0.0.1:${E2E_PORT}`;
    expect((await page.request.put('/api/files/user/customMd', { data: { text: preSession }, headers: { 'if-match': current.etag, 'x-cc': '1', origin } })).status()).toBe(200);
    expect(preSession).not.toContain('Added by Dev Chat');
    await page.goto('/dev');
    await page.getByLabel('Prompt for devchat').fill('Add a scoring rule for recovery');
    await page.getByRole('button', { name: 'Send', exact: true }).first().click();
    // Scoped to the transcript: the git diff panel can hold the same text when custom/ has uncommitted changes.
    await expect(page.locator('p', { hasText: 'Blacklist and supervisor writes were blocked as expected.' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Turn 1' })).toBeVisible();
    expect((await (await page.request.get('/api/files/user/customMd')).json()).text).toContain('Added by Dev Chat');
    const sessions = (await (await page.request.get('/api/sessions')).json()) as Array<{ id: string; mode: string }>;
    const id = sessions.find((s) => s.mode === 'devchat')!.id;
    // The transcript shows the final text a poll before the turn is finalized (post-turn hashes recorded, status settled), and the
    // recovery page refuses a revert until then. The in-app Revert button is disabled for that window; here wait for the same thing.
    const statusOf = async () => ((await (await page.request.get('/api/sessions')).json()) as Array<{ id: string; status: string }>).find((s) => s.id === id)?.status ?? '';
    await expect.poll(statusOf).toMatch(/^(awaiting_user|done|error|cancelled)$/);
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto('/__recovery');
    await page.locator('article', { has: page.getByRole('heading', { name: new RegExp(id) }) }).getByRole('button', { name: 'Revert whole turn' }).click();
    await expect.poll(async () => (await (await page.request.get('/api/files/user/customMd')).json()).text).toBe(preSession);
    expect(errors).toEqual([]);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { axeBuilder } from './helpers.js';
import { E2E_PORT, E2E_TOKEN } from '../../playwright.config.js';

/**
 * The files the fake Dev Chat turn writes, as they are now; the returned function puts them back. A test that runs a turn
 * and does not revert it calls this, or the next test's identical turn changes nothing and has nothing to revert.
 */
function keepTurnFiles(): () => void {
  const root = path.join(process.env.CC_E2E_TMP!, 'root');
  const saved = ['modes/_custom.md', 'data/notes/devchat.md'].map((rel) => {
    const abs = path.join(root, rel);
    return { abs, text: fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null };
  });
  return () => {
    for (const f of saved) {
      if (f.text === null) fs.rmSync(f.abs, { force: true });
      else fs.writeFileSync(f.abs, f.text);
    }
  };
}

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
    // Exactly the three refusals the scenario expects: the blacklist and supervisor writes and the push.
    await expect(page.getByRole('status').filter({ hasText: 'Permission denied' })).toHaveText('Permission denied for Write, Write, Bash: the session stayed inside its write scope.');
    // The changed files as the Changes panel lists them, not the transcript's tool chips.
    const changes = page.getByLabel('Changes');
    await expect(changes.getByRole('heading', { name: 'Turn 1' })).toBeVisible();
    await expect(changes.getByText('modes/_custom.md', { exact: true })).toBeVisible();
    await expect(changes.getByText('data/notes/devchat.md', { exact: true })).toBeVisible();
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

  test('leaving Dev Chat and coming back reopens the conversation and its Changes (SW3-web-b-03)', async ({ page }) => {
    const restore = keepTurnFiles();
    try {
      await page.goto(`/auth?t=${E2E_TOKEN}`);
      await page.goto('/dev');
      await page.getByLabel('Prompt for devchat').fill('Add a scoring rule, then look away');
      await page.getByRole('button', { name: 'Send', exact: true }).first().click();
      await expect(page.locator('p', { hasText: 'Blacklist and supervisor writes were blocked as expected.' })).toBeVisible({ timeout: 20_000 });
      await expect(page).toHaveURL(/\/dev\?session=s/);
      const changes = page.getByLabel('Changes');
      await expect(changes.getByRole('heading', { name: 'Turn 1' })).toBeVisible();
      await page.getByRole('link', { name: 'Runs & Schedule' }).click();
      await expect(page.getByRole('heading', { level: 1, name: /Runs/ })).toBeVisible();
      await page.goBack();
      await expect(page.locator('p', { hasText: 'Blacklist and supervisor writes were blocked as expected.' })).toBeVisible();
      await expect(changes.getByRole('heading', { name: 'Turn 1' })).toBeVisible();
      await expect(changes.getByText('data/notes/devchat.md', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'New conversation' }).click();
      await expect(page).toHaveURL(/\/dev$/);
      await expect(page.getByLabel('Prompt for devchat')).toBeVisible();
    } finally {
      restore();
    }
  });

  test('the sidebar Dev Chat link reopens the same session in the transcript and in Changes (SW3-web-b-03 review)', async ({ page }) => {
    const restore = keepTurnFiles();
    try {
      await page.goto(`/auth?t=${E2E_TOKEN}`);
      await page.goto('/dev');
      await page.getByLabel('Prompt for devchat').fill('Add a scoring rule, then follow the nav link');
      await page.getByRole('button', { name: 'Send', exact: true }).first().click();
      await expect(page.locator('p', { hasText: 'Blacklist and supervisor writes were blocked as expected.' })).toBeVisible({ timeout: 20_000 });
      const id = new URL(page.url()).searchParams.get('session');
      expect(id).toMatch(/^s/);
      await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Dev Chat' }).click();
      await expect(page).toHaveURL(new RegExp(`/dev\\?session=${id}$`));
      await expect(page.locator(`[data-session-id="${id}"]`)).toBeVisible();
      await expect(page.locator('p', { hasText: 'Blacklist and supervisor writes were blocked as expected.' })).toBeVisible();
      await expect(page.getByLabel('Changes').getByRole('heading', { name: 'Turn 1' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'New conversation' })).toBeVisible();
    } finally {
      restore();
    }
  });

  test('a second turn shows up in Changes with its own revert, and the turns revert newest first', async ({ page }) => {
    await page.goto(`/auth?t=${E2E_TOKEN}`);
    await page.goto('/dev');
    await page.getByLabel('Prompt for devchat').fill('Add a scoring rule, then more');
    await page.getByRole('button', { name: 'Send', exact: true }).first().click();
    await expect(page.locator('p', { hasText: 'Blacklist and supervisor writes were blocked as expected.' })).toBeVisible({ timeout: 20_000 });
    const changes = page.getByLabel('Changes');
    await expect(changes.getByRole('heading', { name: 'Turn 1' })).toBeVisible();
    await page.getByLabel('Reply to the session').fill('Rewrite the note');
    await page.getByRole('button', { name: 'Send', exact: true }).last().click();
    await expect(page.locator('p', { hasText: 'Rewrote the note in turn two.' })).toBeVisible({ timeout: 20_000 });
    const turn2 = changes.locator('.card', { has: page.getByRole('heading', { name: 'Turn 2' }) });
    await expect(turn2).toBeVisible();
    await expect(turn2.getByText('data/notes/devchat.md', { exact: true })).toBeVisible();
    await expect(turn2.getByRole('button', { name: 'Revert turn' })).toBeEnabled();
    await turn2.getByRole('button', { name: 'Revert turn' }).click();
    await page.getByRole('dialog', { name: 'Revert turn 2?' }).getByRole('button', { name: 'Revert' }).click();
    await expect(page.getByText(/^Reverted: devchat\.md/)).toBeVisible();
    const turn1 = changes.locator('.card', { has: page.getByRole('heading', { name: 'Turn 1' }) });
    await turn1.getByRole('button', { name: 'Revert turn' }).click();
    await page.getByRole('dialog', { name: 'Revert turn 1?' }).getByRole('button', { name: 'Revert' }).click();
    await expect.poll(async () => (await (await page.request.get('/api/files/user/customMd')).json()).text).not.toContain('Added by Dev Chat');
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

  test('a recorded file that became a directory, or a session with no turns, does not take the recovery page or the app down', async ({ page }) => {
    // The e2e roots sit under CC_E2E_TMP (playwright.config.ts): root/ is the main app's data root, guard/ its guard dir.
    const tmp = process.env.CC_E2E_TMP!;
    const sessions = path.join(tmp, 'root', 'data', 'control-center', 'sessions');
    const guard = path.join(tmp, 'guard', 'sessions');
    const target = path.join(tmp, 'root', 'data', 'notes', 'became-a-dir');
    const ids = ['e2e-recovery-dir', 'e2e-recovery-no-turns', 'e2e-recovery-bad-id'];
    const meta = (id: string, extra: object) => JSON.stringify({ id, mode: 'devchat', status: 'done', createdAt: '2000-01-01T00:00:00.000Z', ...extra });
    try {
      fs.mkdirSync(target, { recursive: true });
      for (const id of ids.slice(0, 2)) fs.mkdirSync(path.join(sessions, id), { recursive: true });
      fs.writeFileSync(path.join(sessions, ids[0]!, 'meta.json'), meta(ids[0]!, { turns: [{ n: 1 }] }));
      fs.writeFileSync(path.join(sessions, ids[1]!, 'meta.json'), meta(ids[1]!, {}));
      const turn = path.join(guard, ids[0]!, 'turns', '1');
      fs.mkdirSync(path.join(turn, 'before'), { recursive: true });
      fs.writeFileSync(path.join(turn, 'turn.json'), JSON.stringify({ filesOffset: 0 }));
      fs.writeFileSync(path.join(turn, 'before', encodeURIComponent(target)), 'old text\n');
      fs.writeFileSync(path.join(guard, ids[0]!, 'files.ndjson'), `${JSON.stringify({ path: 'data/notes/became-a-dir', abs: target, root: 'data', tool: 'Write', ts: 't' })}\n`);
      await page.goto(`/auth?t=${E2E_TOKEN}`);
      const recovery = await page.request.get('/__recovery');
      expect(recovery.status()).toBe(200);
      const html = await recovery.text();
      expect(html).toContain('data/notes/became-a-dir');
      expect(html).toMatch(/unreadable \+0 -0 \(EISDIR/);
      expect(html).toContain(ids[1]);
      expect((await page.request.get('/__supervisor/status')).status()).toBe(200);
      // Anything else that throws while the supervisor answers is a 500, never a crash: an id the guard dir refuses.
      fs.mkdirSync(path.join(sessions, ids[2]!));
      fs.writeFileSync(path.join(sessions, ids[2]!, 'meta.json'), meta('../escape', { turns: [{ n: 1 }] }));
      const broken = await page.request.get('/__recovery');
      expect(broken.status()).toBe(500);
      expect(await broken.text()).toContain('supervisor error: bad session id');
      expect((await page.request.get('/__supervisor/status')).status()).toBe(200);
      expect((await page.request.get('/healthz')).status()).toBe(200);
    } finally {
      for (const id of ids) {
        fs.rmSync(path.join(sessions, id), { recursive: true, force: true });
        fs.rmSync(path.join(guard, id), { recursive: true, force: true });
      }
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
});

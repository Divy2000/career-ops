import { test, expect, type Page } from '@playwright/test';
import { axeBuilder } from './helpers.js';
import { E2E_PORT, E2E_TOKEN } from '../../playwright.config.js';

const WRITE_HEADERS = { 'X-CC': '1', Origin: `http://127.0.0.1:${E2E_PORT}`, 'content-type': 'application/json' };

async function login(page: Page) {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

async function axeClean(page: Page) {
  // Toasts fade out while axe runs; their mid-animation blend is not a page color.
  const axe = await (await axeBuilder(page)).exclude('[data-sonner-toaster]').analyze();
  const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
}

test.describe('P3 editors and P6 polish', () => {
  test.beforeEach(async ({ page }) => login(page));

  test('structured portals editor toggles a tracked company through yaml ops and keeps the file comment', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'tracked_companies' })).toBeVisible();
    // Northwind has no enabled key, as upstream allows (it defaults on): its cell is blank, and typing false sets it.
    const enabled = page.getByLabel('enabled of Northwind Analytics');
    await expect(enabled).toHaveValue('');
    await enabled.fill('false');
    await enabled.press('Enter');
    await expect(page.getByText('1 pending change')).toBeVisible();
    await page.getByRole('button', { name: 'Validate and save' }).click();
    await expect(page.getByRole('status')).toContainText('Saved portals.yml');
    const saved = await (await page.request.get('/api/config/portals')).json();
    expect(saved.raw.startsWith('# Synthetic portals config for tests')).toBe(true);
    expect(saved.raw).toMatch(/provider: lever\n\s+enabled: false/);
    expect(saved.doc.tracked_companies[1].enabled).toBe(false);
    await axeClean(page);
  });

  test('a stale structured save shows the merge UI and saving again applies the pending edits on top', async ({ page }) => {
    await page.goto('/settings');
    const days = page.getByRole('spinbutton', { name: 'max_posting_age_days' });
    await days.fill('21');
    await days.press('Enter');
    await expect(page.getByText('1 pending change')).toBeVisible();
    // The stale-ETag answer is simulated once, so this checks the merge UI on its own (writes.spec.ts covers a
    // real change on disk): the first PUT gets the server's 409 shape with a "changed outside" version of the file.
    const current = await (await page.request.get('/api/config/portals')).json();
    let intercepted = false;
    await page.route('**/api/config/portals', async (route) => {
      if (route.request().method() === 'PUT' && !intercepted) {
        intercepted = true;
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'the file changed since you loaded it', current: { ...current, raw: `# changed outside the editor\n${current.raw}` } }) });
        return;
      }
      await route.continue();
    });
    await page.getByRole('button', { name: 'Validate and save' }).click();
    await expect(page.getByRole('alert')).toContainText('changed on disk');
    await expect(page.getByText('Current version on disk')).toBeVisible();
    await expect(page.getByText('# changed outside the editor')).toBeVisible();
    await expect(page.getByText('1 pending change')).toBeVisible();
    await page.getByRole('button', { name: 'Validate and save' }).click();
    await expect(page.getByRole('status')).toContainText('Saved portals.yml');
    const merged = await (await page.request.get('/api/config/portals')).json();
    expect(merged.doc.max_posting_age_days).toBe(21);
    expect(merged.raw.startsWith('# Synthetic portals config for tests')).toBe(true);
  });

  test('profile form adds a section and the cadence form writes followup_cadence', async ({ page }) => {
    await page.goto('/settings?tab=profile');
    await page.getByRole('button', { name: 'Add language' }).click();
    await page.getByRole('button', { name: 'Validate and save profile' }).click();
    await expect(page.getByRole('status')).toContainText('Saved config/profile.yml');
    await page.getByRole('tab', { name: 'Follow-up cadence' }).click();
    await page.getByLabel('applied_first_days').fill('9');
    await page.getByRole('button', { name: 'Save cadence' }).click();
    await expect(page.getByRole('status')).toContainText('Follow-up cadence saved');
    const profile = await (await page.request.get('/api/config/profile')).json();
    expect(profile.doc.followup_cadence.applied_first_days).toBe(9);
    expect(profile.doc.language.output).toBe('en');
  });

  test('blacklist editor writes only through the explicit confirm dialog and the API refuses bare writes', async ({ page }) => {
    await page.goto('/settings?tab=blacklist');
    await expect(page.getByRole('cell', { name: 'Spam Staffing Ltd', exact: true })).toBeVisible();
    await page.getByLabel('Blacklist company or domain').fill('Evil Corp');
    await page.getByLabel('Blacklist reason').fill('ghosted twice');
    await page.getByRole('button', { name: 'Add row' }).click();
    await page.getByRole('button', { name: 'Save blacklist' }).click();
    const dialog = page.getByRole('dialog', { name: 'Write data/blacklist.md?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Write blacklist' }).click();
    await expect(page.getByRole('status')).toContainText('Blacklist written');
    const read = await (await page.request.get('/api/blacklist')).json();
    expect(read.rows.map((r: { company: string }) => r.company)).toEqual(['Spam Staffing Ltd', 'Evil Corp']);
    expect(read.raw).toContain('| Company | Since | Scope | Reason |');
    const bare = await page.request.put('/api/blacklist', { headers: WRITE_HEADERS, data: { confirm: true, rows: [] } });
    expect(bare.status()).toBe(403);
    await axeClean(page);
  });

  test('plugins tab enables a plugin by writing config/plugins.yml and shows the skill as untrusted', async ({ page }) => {
    await page.goto('/settings?tab=plugins');
    await page.getByLabel('Enable gmail').click();
    await expect(page.getByLabel('Enable gmail')).toBeChecked();
    const list = await (await page.request.get('/api/plugins')).json();
    expect(list.plugins.find((p: { id: string }) => p.id === 'gmail').enabled).toBe(true);
    await page.getByRole('row', { name: /Gmail ingest/ }).getByRole('button', { name: 'Skill doc' }).click();
    await expect(page.getByText('untrusted plugin documentation')).toBeVisible();
  });

  test('app and engine settings persist and the usage meter renders', async ({ page }) => {
    await page.goto('/settings?tab=engine');
    await page.getByLabel('Claude concurrency').selectOption('3');
    await expect(page.getByText('Concurrency set to 3')).toBeVisible();
    expect((await (await page.request.get('/api/settings/app')).json()).claudeConcurrency).toBe(3);
    await expect(page.getByRole('heading', { name: 'Token usage' })).toBeVisible();
    await page.goto('/settings?tab=app');
    await page.getByLabel('Company logos').click();
    await expect(page.getByLabel('Company logos')).toBeChecked();
    expect((await (await page.request.get('/api/settings/app')).json()).logos).toBe(true);
  });

  test('Runs & Schedule shows both launchd jobs, installs the weekly one through the fake launchctl and browses logs', async ({ page }) => {
    await page.goto('/runs');
    await expect(page.getByRole('heading', { name: 'Daily job' })).toBeVisible();
    const weekly = page.locator('[aria-labelledby="job-weekly"]');
    await expect(weekly.getByRole('heading', { name: 'Weekly upstream sync' })).toBeVisible();
    await expect(weekly.getByText('not installed')).toBeVisible();
    await weekly.getByLabel('Weekly upstream sync hour').fill('4');
    await weekly.getByRole('button', { name: 'Install and enable' }).click();
    await expect(weekly.getByText('loaded, idle')).toBeVisible();
    await expect(weekly.getByText('plist ok')).toBeVisible();
    const schedule = await (await page.request.get('/api/schedule')).json();
    expect(schedule.jobs[1]).toMatchObject({ loaded: true, disabled: false, hour: 4, weekday: 0 });
    // Disable is persistent (launchctl disable), so the card says the job stays off at login.
    await weekly.getByRole('button', { name: 'Disable' }).click();
    await expect(weekly.getByText('disabled at login')).toBeVisible();
    expect((await (await page.request.get('/api/schedule')).json()).jobs[1]).toMatchObject({ loaded: false, disabled: true });
    await weekly.getByRole('button', { name: 'Install and enable' }).click();
    await expect(weekly.getByText('loaded, idle')).toBeVisible();
    expect((await (await page.request.get('/api/schedule')).json()).jobs[1]).toMatchObject({ loaded: true, disabled: false });
    await expect(page.getByLabel('Log 2026-10-03')).toBeVisible();
    await axeClean(page);
  });

  test('command palette navigates with Cmd+K and lists registry actions and modes', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const input = page.getByPlaceholder('Go to a page, run an action or start a mode');
    await expect(input).toBeVisible();
    await input.fill('Insights');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/insights/);
    await page.getByRole('button', { name: 'Open command palette' }).click();
    await input.fill('Doctor');
    await expect(page.getByText('system.doctor')).toBeVisible();
    await input.fill('mode oferta');
    await expect(page.locator('[cmdk-item]', { hasText: /^oferta\b/ }).first()).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('a yes/no parameter in the palette form is a 16px checkbox on the same line as its name', async ({ page }) => {
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Go to a page, run an action or start a mode').fill('tracker.delete');
    await expect(page.locator('[cmdk-item]', { hasText: 'tracker.delete' })).toBeVisible();
    await page.keyboard.press('Enter');
    const row = page.locator('[role="dialog"].dialog label', { hasText: 'dryRun' });
    const box = (await row.getByRole('checkbox').boundingBox())!;
    const text = (await row.evaluate((label) => {
      const range = document.createRange();
      range.selectNodeContents(label.lastChild!);
      const r = range.getBoundingClientRect();
      return { x: r.x, y: r.y, height: r.height };
    }))!;
    expect(box.width).toBeCloseTo(16, 0);
    // Side by side: the name starts after the box, and the two share a line.
    expect(text.x).toBeGreaterThan(box.x + box.width);
    expect(Math.abs(text.y + text.height / 2 - (box.y + box.height / 2))).toBeLessThan(6);
    await page.keyboard.press('Escape');
  });

  test('Insights script tabs, Interviews, Follow-ups tabs and Tracker compare reach their new homes', async ({ page }) => {
    await page.goto('/insights?tab=velocity');
    await expect(page.getByRole('heading', { name: 'Funnel velocity (funnel-velocity.mjs)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Recompute' })).toBeVisible();
    await expect(page.getByText(/computed \d{4}-\d{2}-\d{2}/)).toBeVisible({ timeout: 30_000 });
    await page.goto('/interviews');
    await expect(page.getByRole('heading', { level: 1, name: 'Interviews' })).toBeVisible();
    await expect(page.locator('#story-heading')).toHaveText('Story bank');
    await expect(page.getByText('interview-prep/acme-robotics-prep.md')).toBeVisible();
    await axeClean(page);
    await page.goto('/followups?tab=contacts');
    await expect(page.getByRole('cell', { name: 'Pat Example' })).toBeVisible();
    await page.getByRole('tab', { name: 'Replies' }).click();
    await expect(page.getByRole('heading', { name: 'Paste a reply' })).toBeVisible();
    await page.goto('/tracker');
    await page.getByLabel('Select Acme Robotics').check();
    await page.getByLabel('Select Northwind Analytics').check();
    await page.getByRole('button', { name: /Compare selected/ }).click();
    await expect(page.getByRole('heading', { name: 'Compare 2 applications' })).toBeVisible();
  });

  test('destructive actions confirm through a dialog instead of window.confirm', async ({ page }) => {
    await page.goto('/sessions');
    await page.getByRole('button', { name: 'New session' }).click();
    await page.getByLabel('New session mode').selectOption('tracker');
    await page.getByLabel('Prompt for tracker').fill('Which rows need a follow-up this week?');
    await page.getByRole('button', { name: 'Start session' }).click();
    const first = page.locator('tbody tr').first();
    await expect(first).toContainText('tracker');
    await expect(first).toContainText(/done|needs your reply|error/, { timeout: 30_000 });
    await first.getByRole('link').click();
    await page.getByRole('button', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this session?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('tracker');
  });
});

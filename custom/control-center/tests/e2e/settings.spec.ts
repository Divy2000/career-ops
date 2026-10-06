import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { axeBuilder, snapshotDataFiles } from './helpers.js';
import { E2E_TOKEN } from '../../playwright.config.js';

test.describe('Settings', () => {
  test('portals editor validates before writing, rejects a broken file and saves a good one', async ({ page }) => {
    const restore = snapshotDataFiles('portals.yml');
    try {
      await page.goto(`/auth?t=${E2E_TOKEN}`);
      await page.goto('/settings');
      await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
      await page.getByRole('tab', { name: 'Raw YAML' }).click();
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
      // The rejected save's error toast may still be fading out; its mid-animation blend is not a page color (as in polish.spec.ts).
      const axe = await (await axeBuilder(page)).exclude('[data-sonner-toaster]').analyze();
      expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
    } finally {
      restore();
    }
  });

  test('Health shows what Validate portals.yml found on stdout and what the tracker sync check wrote to stderr (R8-06)', async ({ page }) => {
    const portals = path.join(process.env.CC_E2E_TMP!, 'root', 'portals.yml');
    const original = fs.readFileSync(portals, 'utf8');
    await page.goto(`/auth?t=${E2E_TOKEN}`);
    await page.goto('/settings?tab=health');
    const output = page.getByLabel('Action output');
    // tracker.mjs sync --check reports on stderr only, and exits 0 on a clean tracker.
    await page.getByRole('button', { name: /Tracker sync check/ }).click();
    await expect(output).toContainText('No corruption detected');
    try {
      fs.writeFileSync(portals, 'tracked_companies:\n  - careers_url: not a url\n    enabled: true\n');
      await page.getByRole('button', { name: /Validate portals\.yml/ }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'portals.validate exited 1' })).toBeVisible();
      await expect(output).toContainText('error: tracked_companies[0].careers_url: invalid URL: not a url');
      await expect(output).toContainText('2 errors, 0 warnings');
    } finally {
      fs.writeFileSync(portals, original);
    }
    const axe = await (await axeBuilder(page)).exclude('[data-sonner-toaster]').analyze();
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  });

  test('a section another writer filled while "Add job_boards" was pending survives the save after the conflict (SW2-tests-02)', async ({ page }) => {
    const portals = path.join(process.env.CC_E2E_TMP!, 'root', 'portals.yml');
    const original = fs.readFileSync(portals, 'utf8');
    try {
      await page.goto(`/auth?t=${E2E_TOKEN}`);
      await page.goto('/settings');
      await page.getByRole('button', { name: 'Add job_boards' }).click();
      await page.getByRole('button', { name: 'Add search_queries' }).click();
      await expect(page.getByText('2 pending changes')).toBeVisible();
      // A session writes two boards meanwhile.
      fs.writeFileSync(portals, `${original}\njob_boards:\n  - name: Board One\n    careers_url: https://boards.example.com/one\n  - name: Board Two\n    careers_url: https://boards.example.com/two\n`);
      await expect(page.getByRole('alert').filter({ hasText: 'changed on disk since you started editing' })).toBeVisible();
      await page.getByRole('button', { name: 'Validate and save' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'changed on disk since you loaded it' })).toBeVisible();
      await page.getByRole('button', { name: 'Validate and save' }).click();
      await expect(page.getByRole('status')).toContainText('Saved portals.yml');
      const saved = await (await page.request.get('/api/config/portals')).json();
      expect(saved.doc.job_boards.map((b: { name: string }) => b.name)).toEqual(['Board One', 'Board Two']);
      expect(saved.doc.search_queries).toEqual([]);
    } finally {
      fs.writeFileSync(portals, original);
    }
  });

  test('with no data/blacklist.md yet, the add-to-blacklist link opens the editor and saving creates the file (SW3-web-b-01)', async ({ page }) => {
    const file = path.join(process.env.CC_E2E_TMP!, 'root', 'data', 'blacklist.md');
    const original = fs.readFileSync(file, 'utf8');
    fs.rmSync(file);
    try {
      await page.goto(`/auth?t=${E2E_TOKEN}`);
      await page.goto('/settings?tab=blacklist&add=Acme%20Staffing');
      await expect(page.getByText('data/blacklist.md not created yet')).toBeVisible();
      await expect(page.getByText('File missing')).toHaveCount(0);
      await expect(page.getByLabel('Blacklist company or domain')).toHaveValue('Acme Staffing');
      await page.getByLabel('Blacklist reason').fill('spam postings');
      await page.getByRole('button', { name: 'Add row' }).click();
      await page.getByRole('button', { name: 'Save blacklist' }).click();
      await page.getByRole('dialog', { name: 'Write data/blacklist.md?' }).getByRole('button', { name: 'Write blacklist' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Blacklist written.' })).toBeVisible();
      expect(fs.readFileSync(file, 'utf8')).toContain('| Acme Staffing |');
    } finally {
      fs.writeFileSync(file, original);
    }
  });

  test('switching a tab with unsaved edits asks first, and Cancel keeps them (SW3-web-b-02)', async ({ page }) => {
    await page.goto(`/auth?t=${E2E_TOKEN}`);
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Add job_boards' }).click();
    await expect(page.getByText('1 pending change')).toBeVisible();
    await page.getByRole('tab', { name: 'Raw YAML' }).click();
    const ask = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
    await expect(ask).toContainText('portals.yml');
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('1 pending change')).toBeVisible();
    // A top-level tab asks too.
    await page.getByRole('tab', { name: 'Blacklist' }).click();
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Discard changes' }).click();
    await expect(page).toHaveURL(/tab=blacklist/);
    await expect(page.getByRole('heading', { name: /Blacklist/ })).toBeVisible();
  });

  test('Add target_roles offers the archetype columns and saves an archetype as an object (SW3-web-b-04)', async ({ page }) => {
    const profile = path.join(process.env.CC_E2E_TMP!, 'root', 'config', 'profile.yml');
    const original = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf8') : null;
    try {
      if (original !== null) fs.writeFileSync(profile, original.replace(/^target_roles:[\s\S]*?(?=^\S|$(?![\s\S]))/m, ''));
      await page.goto(`/auth?t=${E2E_TOKEN}`);
      await page.goto('/settings?tab=profile');
      await page.getByRole('button', { name: 'Add target_roles' }).click();
      const roles = page.locator('section[aria-labelledby="profile-target_roles"]');
      await roles.getByLabel('New target_roles.archetypes name').fill('AI Engineer');
      await roles.getByLabel('New target_roles.archetypes fit').fill('primary');
      await roles.getByRole('button', { name: 'Add row' }).click();
      await page.getByRole('button', { name: 'Validate and save profile' }).click();
      await expect(page.getByRole('status')).toContainText('Saved config/profile.yml');
      const saved = await (await page.request.get('/api/config/profile')).json();
      expect(saved.doc.target_roles.archetypes).toEqual([{ name: 'AI Engineer', fit: 'primary' }]);
    } finally {
      if (original === null) fs.rmSync(profile, { force: true });
      else fs.writeFileSync(profile, original);
    }
  });

  test('browser Back and a sidebar link ask before dropping unsaved blacklist rows (SW4-web-b-01)', async ({ page }) => {
    await page.goto(`/auth?t=${E2E_TOKEN}`);
    await page.goto('/settings?tab=portals');
    await page.getByRole('tab', { name: 'Blacklist' }).click();
    await expect(page).toHaveURL(/tab=blacklist/);
    await page.getByLabel('Blacklist company or domain').fill('Spam Co');
    await page.getByRole('button', { name: 'Add row' }).click();
    const ask = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
    await page.goBack();
    await expect(ask).toContainText('data/blacklist.md');
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(page).toHaveURL(/tab=blacklist/);
    await expect(page.getByRole('cell', { name: 'Spam Co', exact: true })).toBeVisible();
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Runs & Schedule' }).click();
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Discard changes' }).click();
    await expect(page).toHaveURL(/\/runs/);
  });

  test('the structured portals editor refuses an enabled tracked company the scanner could not reach', async ({ page }) => {
    await page.goto(`/auth?t=${E2E_TOKEN}`);
    await page.goto('/settings');
    const companies = page.locator('section[aria-labelledby="portals-tracked_companies"]');
    await companies.getByLabel('New tracked_companies name').fill('Umbrella Corp');
    await companies.getByRole('button', { name: 'Add row' }).click();
    await expect(companies.getByRole('alert')).toContainText('Umbrella Corp: needs a careers_url or an api URL');
    await expect(page.getByText('0 pending changes')).toBeVisible();
    await companies.getByLabel('New tracked_companies careers_url').fill('https://job-boards.greenhouse.io/umbrella');
    await companies.getByRole('button', { name: 'Add row' }).click();
    await expect(page.getByText('1 pending change')).toBeVisible();
    await page.getByRole('button', { name: 'Discard changes' }).click();

    // An existing company whose URL is cleared: the save is held back and the page says which one and why.
    const url = page.getByLabel('careers_url of Acme Robotics');
    await url.fill('');
    await url.press('Enter');
    await expect(page.getByText('1 pending change')).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Acme Robotics: needs a careers_url or an api URL' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Validate and save' })).toBeDisabled();
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.getByRole('button', { name: 'Validate and save' })).toBeDisabled();
    await expect(page.getByRole('alert').filter({ hasText: 'Acme Robotics' })).toHaveCount(0);
  });

  test('an unapproved Claude Code leaves the app running: the setup chip and Settings > AI engine say sessions are refused', async ({ page }) => {
    const problem = 'Claude Code 2.1.290 is not approved for Control Center sessions (approved: 2.1.289); run `npm run probe:reads` and add it. Sessions are refused until then; the rest of the app works.';
    await page.route('**/api/system/status', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { claude: Record<string, unknown> };
      await route.fulfill({ response: res, json: { ...body, claude: { ...body.claude, version: '2.1.290 (Claude Code)', approved: false, problem } } });
    });
    await page.goto(`/auth?t=${E2E_TOKEN}`);
    const chip = page.getByRole('link', { name: 'Setup needs attention' });
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('title', /2\.1\.290 is not approved/);
    await chip.click();
    await expect(page.getByRole('tab', { name: 'AI engine', selected: true })).toBeVisible();
    await expect(page.getByText(problem)).toBeVisible();
  });
});

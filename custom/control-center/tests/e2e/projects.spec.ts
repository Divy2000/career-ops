import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { axeBuilder } from './helpers.js';
import { E2E_TOKEN } from '../../playwright.config.js';

async function login(page: Page) {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

async function seriousViolations(page: Page) {
  const axe = await (await axeBuilder(page)).analyze();
  return axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

test.describe('Profile > Projects library', () => {
  test.beforeEach(async ({ page }) => login(page));

  test('add a project, save, see it listed, rank against a JD, then delete it', async ({ page }) => {
    await page.goto('/profile');
    await page.getByRole('tab', { name: 'Projects' }).click();
    const list = page.getByRole('list', { name: 'Projects in the library' });
    await expect(list.getByRole('heading', { name: 'Event Router' })).toBeVisible();
    await expect(list.getByText('Article', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Add project' }).click();
    const form = page.getByRole('form', { name: 'Add a project' });
    await form.getByLabel('Title').fill('Kite Tracker');
    await form.getByLabel('Link').fill('https://example.org/kites');
    await form.getByLabel('Tags').fill('kafka, python');
    await form.getByLabel('Bullet 1', { exact: true }).fill('Tracked 40 kites with Kafka streams.');
    await form.getByRole('button', { name: 'Add bullet' }).click();
    await form.getByLabel('Bullet 2', { exact: true }).fill('Plotted flight paths in Python.');
    await form.getByRole('button', { name: 'Move bullet 2 up' }).click();
    await expect(form.getByLabel('Bullet 1', { exact: true })).toHaveValue('Plotted flight paths in Python.');
    await form.getByRole('button', { name: 'Save project' }).click();
    await expect(list.getByRole('heading', { name: 'Kite Tracker' })).toBeVisible();
    const saved = await (await page.request.get('/api/projects')).json();
    const kite = saved.entries.find((e: { id: string }) => e.id === 'kite-tracker');
    expect(kite).toMatchObject({ url: 'https://example.org/kites', tags: ['kafka', 'python'], bullets: ['Plotted flight paths in Python.', 'Tracked 40 kites with Kafka streams.'] });

    await page.getByLabel('Job description').fill('We need Python and Kafka experience for streaming services.');
    await page.getByRole('button', { name: 'Rank projects' }).click();
    const ranking = page.getByLabel('Ranking', { exact: true });
    await expect(ranking.getByRole('heading', { name: 'Recommended' })).toBeVisible();
    await expect(ranking.locator('.rank-item__title')).toHaveText(['Event Router', 'Kite Tracker']);
    expect(await seriousViolations(page)).toEqual([]);

    await page.getByRole('button', { name: 'Delete Kite Tracker' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(list.getByRole('heading', { name: 'Kite Tracker' })).toHaveCount(0);
  });

  test('a bullet another writer added while the form was open survives the save after the conflict (SW2-tests-01)', async ({ page }) => {
    const digest = path.join(process.env.CC_E2E_TMP!, 'root', 'article-digest.md');
    const original = fs.readFileSync(digest, 'utf8');
    try {
      await page.goto('/profile');
      await page.getByRole('tab', { name: 'Projects' }).click();
      await page.getByRole('button', { name: 'Edit Event Router' }).click();
      const form = page.getByRole('form', { name: 'Edit Event Router' });
      await form.getByLabel('Title').fill('Event Router v2');
      // A session adds a bullet to this very entry while the user renames it.
      fs.writeFileSync(digest, original.replace('- Added replay tooling for failed deliveries.\n', '- Added replay tooling for failed deliveries.\n- Added elsewhere.\n'));
      await expect(page.getByText('article-digest.md changed on disk since you opened this form')).toBeVisible();
      await page.getByRole('button', { name: 'Save project' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'changed on disk' })).toBeVisible();
      await page.getByRole('button', { name: 'Save project' }).click();
      await expect(page.getByRole('list', { name: 'Projects in the library' }).getByRole('heading', { name: 'Event Router v2' })).toBeVisible();
      const saved = await (await page.request.get('/api/projects')).json();
      const entry = saved.entries.find((e: { title: string }) => e.title === 'Event Router v2');
      expect(entry.bullets).toEqual(['Built a Python event router that handles 2,000 messages per second.', 'Added replay tooling for failed deliveries.', 'Added elsewhere.']);
    } finally {
      fs.writeFileSync(digest, original);
    }
  });

  test('an entry renamed on disk while its form is open is saved under its new name, not added a second time (SW2-tests-01)', async ({ page }) => {
    const digest = path.join(process.env.CC_E2E_TMP!, 'root', 'article-digest.md');
    const original = fs.readFileSync(digest, 'utf8');
    try {
      await page.goto('/profile');
      await page.getByRole('tab', { name: 'Projects' }).click();
      await page.getByRole('button', { name: 'Edit Event Router' }).click();
      const form = page.getByRole('form', { name: 'Edit Event Router' });
      await form.getByLabel('Tags').fill('python, kafka, go');
      // Another writer renames the entry; its id comes from the title, so the form's id is gone and the PUT gets a 404.
      fs.writeFileSync(digest, original.replace('## Event Router -- https://github.com/alex-example/event-router', '## Event Routing -- https://github.com/alex-example/event-router'));
      await page.getByRole('button', { name: 'Save project' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'renamed on disk to "Event Routing"' })).toBeVisible();
      await expect(page.getByLabel('Title')).toHaveValue('Event Routing');
      await page.getByRole('button', { name: 'Save project' }).click();
      const list = page.getByRole('list', { name: 'Projects in the library' });
      await expect(list.getByRole('heading', { name: 'Event Routing' })).toBeVisible();
      const saved = await (await page.request.get('/api/projects')).json();
      const titles = saved.entries.map((e: { title: string }) => e.title);
      expect(titles.filter((t: string) => t.startsWith('Event Rout'))).toEqual(['Event Routing']);
      expect(saved.entries.find((e: { title: string }) => e.title === 'Event Routing').tags).toEqual(['python', 'kafka', 'go']);
    } finally {
      fs.writeFileSync(digest, original);
    }
  });

  test('with no article-digest.md yet, Add project opens its form and the first save creates the file (SW3-web-b-01)', async ({ page }) => {
    const digest = path.join(process.env.CC_E2E_TMP!, 'root', 'article-digest.md');
    const original = fs.readFileSync(digest, 'utf8');
    fs.rmSync(digest);
    try {
      await page.goto('/profile');
      await page.getByRole('tab', { name: 'Projects' }).click();
      await expect(page.getByText('No article-digest.md yet')).toBeVisible();
      await page.getByRole('button', { name: 'Add project' }).click();
      const form = page.getByRole('form', { name: 'Add a project' });
      await form.getByLabel('Title').fill('First Project');
      await form.getByLabel('Bullet 1', { exact: true }).fill('Built the first thing.');
      await form.getByRole('button', { name: 'Save project' }).click();
      await expect(page.getByRole('list', { name: 'Projects in the library' }).getByRole('heading', { name: 'First Project' })).toBeVisible();
      expect(fs.readFileSync(digest, 'utf8')).toContain('First Project');
    } finally {
      fs.writeFileSync(digest, original);
    }
  });

  test('a project with no bullets is refused before saving and the draft stays', async ({ page }) => {
    await page.goto('/profile');
    await page.getByRole('tab', { name: 'Projects' }).click();
    await page.getByRole('button', { name: 'Add project' }).click();
    const form = page.getByRole('form', { name: 'Add a project' });
    await form.getByLabel('Title').fill('Half Done');
    await form.getByRole('button', { name: 'Save project' }).click();
    await expect(form.getByRole('alert')).toHaveText(/Add at least one bullet/);
    await expect(form.getByLabel('Title')).toHaveValue('Half Done');
    await form.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('form', { name: 'Add a project' })).toHaveCount(0);
  });
});

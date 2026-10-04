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

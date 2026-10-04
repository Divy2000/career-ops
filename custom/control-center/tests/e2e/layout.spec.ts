/// <reference lib="dom" />
import { test, expect, type Page } from '@playwright/test';
import { E2E_TOKEN } from '../../playwright.config.js';

// Runs against an app whose data root has real-world sized rows (long locations, roles, rank reasons and policy URLs).
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
];
const PAGES = ['/', '/pipeline', '/pipeline?tab=shortlist', '/tracker', '/insights', '/runs', '/sponsorship', '/sponsorship?tab=lookup&q=Acme%20Robotics', '/followups', '/tutorials'];

async function login(page: Page) {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

/** Page-level and card-level horizontal overflow; scroll containers inside a card are allowed to scroll. */
async function overflowProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const main = document.querySelector('.shell__main') as HTMLElement;
    if (document.documentElement.scrollWidth > window.innerWidth) problems.push(`document scrollWidth ${document.documentElement.scrollWidth} > ${window.innerWidth}`);
    if (main.scrollWidth > main.clientWidth) problems.push(`main scrollWidth ${main.scrollWidth} > clientWidth ${main.clientWidth}`);
    const side = document.querySelector('.shell__side') as HTMLElement;
    if (side.scrollWidth > side.clientWidth) problems.push(`sidebar scrollWidth ${side.scrollWidth} > clientWidth ${side.clientWidth}`);
    for (const card of document.querySelectorAll('.card')) {
      const box = card.getBoundingClientRect();
      for (const el of card.querySelectorAll('*')) {
        if (el.classList.contains('sr-only')) continue;
        let scrolls = false;
        for (let p = el.parentElement; p && p !== card; p = p.parentElement) {
          if (getComputedStyle(p).overflowX !== 'visible') scrolls = true;
        }
        if (scrolls) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > box.right + 1 || r.left < box.left - 1) problems.push(`<${el.tagName.toLowerCase()} class="${el.className}"> "${(el.textContent ?? '').slice(0, 40)}" spills out of its card by ${Math.round(Math.max(r.right - box.right, box.left - r.left))}px`);
      }
    }
    return problems.slice(0, 8);
  });
}

for (const viewport of VIEWPORTS) {
  test.describe(`layout at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });
    test.beforeEach(async ({ page }) => login(page));

    for (const url of PAGES) {
      test(`${url} has no horizontal overflow`, async ({ page }) => {
        await page.goto(url);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.locator('.skeleton')).toHaveCount(0);
        expect(await overflowProblems(page)).toEqual([]);
      });
    }

    test('Today: the shortlist keeps its Evaluate column inside its card and the policy card shows a compact markdown summary', async ({ page }) => {
      await expect(page.locator('.skeleton')).toHaveCount(0);
      const shortlist = page.locator('.card', { has: page.getByRole('heading', { name: /^Shortlist/ }) });
      const card = (await shortlist.boundingBox())!;
      const evaluate = await shortlist.getByRole('button', { name: 'Evaluate' }).first().boundingBox();
      expect(evaluate!.x + evaluate!.width).toBeLessThanOrEqual(card.x + card.width);
      const first = await shortlist.locator('tbody tr').first().boundingBox();
      expect(first!.height).toBeLessThan(90);
      await expect(shortlist.locator('.clip[title]').first()).toHaveAttribute('title', /.+/);

      const policy = page.locator('.card', { has: page.getByRole('heading', { name: 'Policy today' }) });
      await expect(policy).not.toContainText('**');
      await expect(policy).not.toContainText('https://');
      expect(await policy.getByRole('list', { name: 'Policy highlights' }).getByRole('listitem').count()).toBeLessThanOrEqual(4);
      await expect(policy.getByRole('link', { name: 'Read full digest' })).toHaveAttribute('href', /\/sponsorship/);
    });

    test('Pipeline: the filters share one row and each row keeps its Skip button on screen', async ({ page }) => {
      await page.goto('/pipeline');
      await expect(page.locator('.skeleton')).toHaveCount(0);
      const search = (await page.getByLabel('Filter inbox').boundingBox())!;
      const source = (await page.getByLabel('Source', { exact: true }).boundingBox())!;
      const level = (await page.getByLabel('Seniority').boundingBox())!;
      expect(source.width).toBeLessThan(320);
      expect(Math.abs(source.y - search.y)).toBeLessThan(8);
      expect(Math.abs(level.y - search.y)).toBeLessThan(8);
      const skip = (await page.getByRole('button', { name: /^Skip / }).first().boundingBox())!;
      expect(skip.x + skip.width).toBeLessThanOrEqual(viewport.width);
      const row = (await page.locator('tbody tr').first().boundingBox())!;
      expect(row.height).toBeLessThan(100);
    });

    test('Runs: the page title has its own row above the grouped script buttons', async ({ page }) => {
      await page.goto('/runs');
      await expect(page.locator('.skeleton')).toHaveCount(0);
      const h1 = (await page.getByRole('heading', { level: 1 }).boundingBox())!;
      expect(h1.height).toBeLessThan(50);
      const group = (await page.getByRole('group', { name: 'Insights' }).boundingBox())!;
      expect(group.y).toBeGreaterThan(h1.y + h1.height);
    });
  });
}

/// <reference lib="dom" />
import { test, expect, type Page } from '@playwright/test';
import { E2E_TOKEN } from '../../playwright.config.js';
import { NAV_GROUPS } from '../../web/nav.js';

const ROUTES = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.to));
const TABS: Record<string, string[]> = {
  '/pipeline': ['shortlist', 'batch'],
  '/sponsorship': ['changes', 'feed', 'alerts', 'companies', 'lookup', 'tiers'],
  '/insights': ['progress', 'breakdown', 'velocity', 'patterns', 'salary', 'skills', 'legitimacy', 'ai'],
  '/followups': ['replies', 'contacts'],
  '/discover': ['portal', 'ai', 'fresh', 'funded', 'reposts'],
  '/settings': ['profile', 'rules', 'blacklist', 'plugins', 'engine', 'health', 'updates', 'app'],
};
const EXTRA = [
  ...Object.entries(TABS).flatMap(([route, tabs]) => tabs.map((tab) => `${route}?tab=${tab}`)),
  '/tracker/1',
  '/sponsorship?tab=lookup&q=JPMorgan%20Chase%20%26%20Co.',
  '/sponsorship?tab=lookup&q=Mega%20Holdings&mode=search',
];

async function login(page: Page) {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

const menuButton = (page: Page) => page.getByRole('button', { name: 'Menu' });
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Primary' });

test.describe('narrow window (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test.beforeEach(async ({ page }) => login(page));

  for (const url of [...ROUTES, ...EXTRA]) {
    test(`${url} fits the viewport and keeps the top bar on one line`, async ({ page }) => {
      await page.goto(url);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('.skeleton')).toHaveCount(0);
      const m = await page.evaluate(() => {
        const top = document.querySelector('.shell__top') as HTMLElement;
        const main = document.querySelector('.shell__main') as HTMLElement;
        const trigger = document.querySelector('.palette-trigger') as HTMLElement;
        return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, mainScroll: main.scrollWidth, mainClient: main.clientWidth, topScroll: top.scrollWidth, topClient: top.clientWidth, triggerHeight: trigger.getBoundingClientRect().height };
      });
      expect(m.scrollWidth).toBeLessThanOrEqual(m.innerWidth);
      expect(m.mainScroll).toBeLessThanOrEqual(m.mainClient);
      expect(m.topScroll).toBeLessThanOrEqual(m.topClient);
      expect(m.triggerHeight).toBeLessThan(40);
    });
  }

  test('the sidebar is hidden until the menu button opens it, and a nav click closes it', async ({ page }) => {
    await expect(sidebar(page)).toBeHidden();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await menuButton(page).click();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(sidebar(page)).toBeVisible();
    await sidebar(page).getByRole('link', { name: 'Tutorials' }).click();
    await expect(page).toHaveURL(/\/tutorials$/);
    await expect(sidebar(page)).toBeHidden();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('clicking the link of the page you are already on also closes the sidebar', async ({ page }) => {
    await menuButton(page).click();
    await sidebar(page).getByRole('link', { name: 'Today' }).click();
    await expect(sidebar(page)).toBeHidden();
  });

  test('Escape closes the open sidebar and returns focus to the menu button', async ({ page }) => {
    await menuButton(page).click();
    await expect(sidebar(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sidebar(page)).toBeHidden();
    await expect(menuButton(page)).toBeFocused();
  });

  test('the menu button toggles the sidebar closed again', async ({ page }) => {
    await menuButton(page).click();
    await menuButton(page).click();
    await expect(sidebar(page)).toBeHidden();
  });
});

test.describe('desktop window (1440x900)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.beforeEach(async ({ page }) => login(page));

  test('the sidebar is always visible and there is no menu button', async ({ page }) => {
    await expect(sidebar(page)).toBeVisible();
    await expect(menuButton(page)).toBeHidden();
    const box = (await sidebar(page).boundingBox())!;
    expect(box.width).toBe(232);
  });
});

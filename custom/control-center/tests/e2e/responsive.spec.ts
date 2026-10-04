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
      const regions = await page.evaluate(() => [...document.querySelectorAll('.table-scroll')].map((el) => ({ tabindex: el.getAttribute('tabindex'), role: el.getAttribute('role'), label: el.getAttribute('aria-label') })));
      for (const r of regions) expect(r).toEqual({ tabindex: '0', role: 'region', label: expect.stringMatching(/\S/) });
    });
  }

  test('a scrollable table region takes keyboard focus and shows the focus ring', async ({ page }) => {
    await page.goto('/');
    const region = page.getByRole('region', { name: /shortlist/i });
    await expect(region).toBeVisible();
    await page.keyboard.press('Tab');
    await region.focus();
    await expect(region).toBeFocused();
    const outline = await region.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe('none');
  });

  for (const [name, status, sessions] of [
    ['setup needs attention and a running session', { code: 200, token: false }, [{ status: 'running' }, { status: 'running' }, { status: 'running' }, { status: 'queued' }]],
    ['status unavailable and sessions waiting for you', { code: 500, token: true }, [{ status: 'awaiting_user' }, { status: 'awaiting_user' }]],
  ] as const) {
    test(`the top bar still fits with ${name}`, async ({ page }) => {
      await page.route('**/api/system/status', async (route) => {
        if (status.code !== 200) return route.fulfill({ status: status.code, contentType: 'application/json', body: '{"error":"forced"}' });
        const res = await route.fetch();
        const body = (await res.json()) as Record<string, unknown>;
        await route.fulfill({ response: res, json: { ...body, keychainTokenPresent: status.token } });
      });
      await page.route('**/api/sessions', (route) => route.fulfill({ json: sessions }));
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
      await expect(page.getByRole('link', { name: /^Activity:/ })).toBeVisible();
      const m = await page.evaluate(() => {
        const top = document.querySelector('.shell__top') as HTMLElement;
        const items = [...top.children].filter((el) => (el.textContent ?? '').trim() !== '' && el.getBoundingClientRect().width > 0);
        const boxes = items.map((el) => ({ name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30), left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, clipped: el.scrollWidth > el.clientWidth + 1 }));
        return { topScroll: top.scrollWidth, topClient: top.clientWidth, innerWidth: window.innerWidth, boxes };
      });
      expect(m.topScroll).toBeLessThanOrEqual(m.topClient);
      expect(m.boxes.filter((b) => b.clipped).map((b) => b.name)).toEqual([]);
      expect(m.boxes.at(-1)!.right).toBeLessThanOrEqual(m.innerWidth);
      expect(m.boxes[0]!.left).toBeGreaterThanOrEqual(0);
      for (let i = 1; i < m.boxes.length; i++) expect(m.boxes[i]!.left, `${m.boxes[i]!.name} overlaps ${m.boxes[i - 1]!.name}`).toBeGreaterThanOrEqual(m.boxes[i - 1]!.right - 0.5);
      if (status.code === 200) await expect(page.getByRole('link', { name: 'Setup needs attention' })).toBeVisible();
    });
  }

  test('opening the menu moves focus into the drawer and Tab stays inside it', async ({ page }) => {
    await menuButton(page).click();
    await expect(sidebar(page).getByRole('link', { name: 'Today' })).toBeFocused();
    const inside = () => page.evaluate(() => document.querySelector('#primary-nav')!.contains(document.activeElement));
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      expect(await inside()).toBe(true);
    }
    await sidebar(page).getByRole('link', { name: 'Today' }).focus();
    await page.keyboard.press('Shift+Tab');
    expect(await inside()).toBe(true);
    await expect(sidebar(page).getByRole('link', { name: 'Today' })).not.toBeFocused();
    await page.keyboard.press('Tab');
    await expect(sidebar(page).getByRole('link', { name: 'Today' })).toBeFocused();
  });

  test('closing the menu by choosing a link returns focus to the menu button', async ({ page }) => {
    await menuButton(page).click();
    await sidebar(page).getByRole('link', { name: 'Tutorials' }).click();
    await expect(sidebar(page)).toBeHidden();
    await expect(menuButton(page)).toBeFocused();
  });

  test('an open drawer does not come back after the window is widened and narrowed again', async ({ page }) => {
    await menuButton(page).click();
    await expect(sidebar(page)).toBeVisible();
    await page.setViewportSize({ width: 1000, height: 844 });
    await expect(sidebar(page)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(sidebar(page)).toBeHidden();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
  });

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

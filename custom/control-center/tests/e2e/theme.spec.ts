/// <reference lib="dom" />
import { test, expect, type Page } from '@playwright/test';
import { E2E_TOKEN } from '../../playwright.config.js';

const DARK_BG = 'rgb(11, 13, 18)';
const LIGHT_BG = 'rgb(244, 246, 250)';

async function login(page: Page) {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

const attrs = (page: Page) => page.evaluate(() => ({ theme: document.documentElement.dataset.theme, mode: document.documentElement.dataset.themeMode, scheme: document.documentElement.style.colorScheme }));
const bodyBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
/** The theme-color the browser would use: the first meta whose media query matches. */
const activeThemeColor = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].find((m) => matchMedia(m.getAttribute('media') ?? 'all').matches)?.getAttribute('content') ?? null);

test.describe('no flash of the wrong theme', () => {
  for (const [stored, os, expected] of [
    ['light', 'dark', 'light'],
    ['dark', 'light', 'dark'],
  ] as const) {
    test(`stored ${stored} on a ${os} OS is applied before the app bundle runs`, async ({ browser }) => {
      const ctx = await browser.newContext({ colorScheme: os });
      const page = await ctx.newPage();
      await login(page);
      await page.evaluate((v) => localStorage.setItem('cc.theme', v), stored);
      let release: () => void = () => {};
      const held = new Promise<void>((r) => (release = r));
      await page.route('**/main.tsx*', async (route) => {
        await held;
        await route.continue();
      });
      await page.goto('/', { waitUntil: 'commit' });
      await page.waitForFunction(() => document.documentElement.dataset.theme !== undefined);
      expect(await attrs(page)).toEqual({ theme: expected, mode: stored, scheme: expected });
      release();
      await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
      expect((await attrs(page)).theme).toBe(expected);
      await ctx.close();
    });
  }
});

test.describe('auto follows the OS', () => {
  test('flips live with the OS, including the theme-color meta', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await ctx.newPage();
    await login(page);
    expect(await attrs(page)).toEqual({ theme: 'dark', mode: 'auto', scheme: 'dark' });
    expect(await bodyBg(page)).toBe(DARK_BG);
    expect(await activeThemeColor(page)).toBe('#11141a');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => attrs(page)).toEqual({ theme: 'light', mode: 'auto', scheme: 'light' });
    expect(await bodyBg(page)).toBe(LIGHT_BG);
    expect(await activeThemeColor(page)).toBe('#fbfcfe');
    await ctx.close();
  });

  test('an explicit choice survives a reload and ignores the OS', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await ctx.newPage();
    await login(page);
    await page.evaluate(() => localStorage.setItem('cc.theme', 'light'));
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
    expect(await attrs(page)).toEqual({ theme: 'light', mode: 'light', scheme: 'light' });
    expect(await activeThemeColor(page)).toBe('#fbfcfe');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.emulateMedia({ colorScheme: 'dark' });
    expect((await attrs(page)).theme).toBe('light');
    await ctx.close();
  });
});

test('a change in one tab reaches the other open tab', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'light' });
  const a = await ctx.newPage();
  await login(a);
  const b = await ctx.newPage();
  await b.goto('/');
  await expect(b.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  expect((await attrs(b)).theme).toBe('light');
  await a.evaluate(() => localStorage.setItem('cc.theme', 'dark'));
  await expect.poll(() => attrs(b)).toEqual({ theme: 'dark', mode: 'dark', scheme: 'dark' });
  await ctx.close();
});

test('blocked storage never breaks the app: it renders in Auto', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'light' });
  await ctx.addInitScript(() => {
    const deny = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    Storage.prototype.getItem = deny;
    Storage.prototype.setItem = deny;
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  expect(await attrs(page)).toEqual({ theme: 'light', mode: 'auto', scheme: 'light' });
  expect(errors).toEqual([]);
  await ctx.close();
});

const switcher = (page: Page) => page.getByRole('button', { name: /^Theme:/ });
const stored = (page: Page) => page.evaluate(() => localStorage.getItem('cc.theme'));

test.describe('theme switcher', () => {
  test('sits in the top bar between the setup chip and Ask, named after the mode', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await ctx.newPage();
    await login(page);
    await expect(switcher(page)).toHaveAccessibleName('Theme: Auto (dark)');
    await expect(switcher(page)).toHaveAttribute('aria-haspopup', 'menu');
    await expect(switcher(page)).toHaveAttribute('aria-expanded', 'false');
    const x = async (loc: ReturnType<Page['locator']>) => (await loc.boundingBox())!.x;
    const setup = page.getByRole('link', { name: 'Setup OK' });
    await expect(setup).toBeVisible();
    expect(await x(setup)).toBeLessThan(await x(switcher(page)));
    expect(await x(switcher(page))).toBeLessThan(await x(page.getByRole('button', { name: 'Open Ask drawer' })));
    const box = (await switcher(page).boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(32);
    expect(box.height).toBeGreaterThanOrEqual(32);
    await ctx.close();
  });

  test('works from the keyboard: open, move, choose, focus returns, the choice survives a reload', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await ctx.newPage();
    await login(page);
    await switcher(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu', { name: 'Theme' })).toBeVisible();
    await expect(page.getByRole('menuitemradio', { name: 'Auto' })).toBeFocused();
    await expect(page.getByRole('menuitemradio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitemradio', { name: 'Light' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(switcher(page)).toBeFocused();
    await expect(switcher(page)).toHaveAccessibleName('Theme: Light');
    expect((await attrs(page)).theme).toBe('light');
    expect(await stored(page)).toBe('light');
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
    expect(await attrs(page)).toEqual({ theme: 'light', mode: 'light', scheme: 'light' });
    await switcher(page).focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('menuitemradio', { name: 'Light' })).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.press('Space');
    expect((await attrs(page)).theme).toBe('dark');
    await ctx.close();
  });

  test('Escape and Tab close the menu without changing the theme', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await ctx.newPage();
    await login(page);
    await switcher(page).click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(switcher(page)).toBeFocused();
    await switcher(page).click();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open Ask drawer' })).toBeFocused();
    expect(await stored(page)).toBeNull();
    await switcher(page).click();
    await page.getByRole('heading', { level: 1, name: 'Today' }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    expect((await attrs(page)).mode).toBe('auto');
    await ctx.close();
  });

  test('choosing Auto again hands control back to the OS', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await ctx.newPage();
    await login(page);
    await switcher(page).click();
    await page.getByRole('menuitemradio', { name: 'Light' }).click();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.emulateMedia({ colorScheme: 'dark' });
    expect((await attrs(page)).theme).toBe('light');
    await switcher(page).click();
    await page.getByRole('menuitemradio', { name: 'Auto' }).click();
    await expect.poll(() => attrs(page)).toEqual({ theme: 'dark', mode: 'auto', scheme: 'dark' });
    await expect(switcher(page)).toHaveAccessibleName('Theme: Auto (dark)');
    await ctx.close();
  });

  test('the command palette has an Appearance group', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await ctx.newPage();
    await login(page);
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder(/Go to a page/).fill('Theme: Light');
    await expect(page.getByRole('group', { name: 'Appearance' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
    expect(await attrs(page)).toEqual({ theme: 'light', mode: 'light', scheme: 'light' });
    await ctx.close();
  });

  test('Settings > App has an Appearance radiogroup of preview cards', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await ctx.newPage();
    await login(page);
    await page.goto('/settings?tab=app');
    const group = page.getByRole('radiogroup', { name: 'Appearance' });
    await expect(group).toBeVisible();
    await expect(group.getByRole('radio')).toHaveCount(3);
    await expect(group.getByRole('radio', { name: 'Auto' })).toBeChecked();
    await group.getByRole('radio', { name: 'Light' }).click();
    expect((await attrs(page)).theme).toBe('light');
    await group.getByRole('radio', { name: 'Light' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(group.getByRole('radio', { name: 'Dark' })).toBeFocused();
    await expect(group.getByRole('radio', { name: 'Dark' })).toBeChecked();
    expect((await attrs(page)).theme).toBe('dark');
    // Each preview is drawn in its own theme regardless of the page's.
    const bgs = await group.getByRole('radio').evaluateAll((els) => els.map((el) => [...el.querySelectorAll('.theme-preview__mock')].map((m) => getComputedStyle(m).backgroundColor)));
    expect(bgs).toEqual([['rgb(244, 246, 250)', 'rgb(11, 13, 18)'], ['rgb(244, 246, 250)'], ['rgb(11, 13, 18)']]);
    await ctx.close();
  });
});

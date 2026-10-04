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

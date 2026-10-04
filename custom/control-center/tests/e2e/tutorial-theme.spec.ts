/// <reference lib="dom" />
import { test, expect, type Page } from '@playwright/test';
import { axeBuilder } from './helpers.js';
import { E2E_TOKEN } from '../../playwright.config.js';

const DARK_VIDEO = '/api/tutorials/demo-tour/media/demo-tour.mp4';
const LIGHT_VIDEO = '/api/tutorials/demo-tour/media/demo-tour-light.mp4';

async function login(page: Page) {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

async function open(page: Page, url = '/tutorials') {
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 1, name: 'Tutorials' })).toBeVisible();
  await expect(page.locator('video')).toBeVisible();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
}

const video = (page: Page) => page.locator('video');
const srcOf = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => new URL(v.currentSrc || v.src).pathname);
const snapshot = (page: Page) =>
  video(page).evaluate((v: HTMLVideoElement) => ({ t: v.currentTime, paused: v.paused, rate: v.playbackRate, muted: v.muted, volume: v.volume, track: v.textTracks[0]?.mode ?? null, ready: v.readyState }));
const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const NOTE = 'No light version; showing the dark video';

test.describe('the player follows the theme', () => {
  for (const scheme of ['dark', 'light'] as const) {
    test(`on a ${scheme} system it plays the ${scheme} recording with the ${scheme} poster and thumbnail`, async ({ browser }) => {
      const ctx = await browser.newContext({ colorScheme: scheme });
      const page = await ctx.newPage();
      await login(page);
      await open(page);
      const suffix = scheme === 'light' ? '-light' : '';
      expect(await srcOf(page)).toBe(scheme === 'light' ? LIGHT_VIDEO : DARK_VIDEO);
      await expect(video(page)).toHaveAttribute('poster', `/api/tutorials/demo-tour/media/poster${suffix}.jpg`);
      const thumb = page.getByRole('navigation', { name: 'Tutorials' }).locator('img').first();
      await expect(thumb).toHaveAttribute('src', `/api/tutorials/demo-tour/media/poster${suffix}.jpg`);
      await expect.poll(() => thumb.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
      await expect(page.getByText(NOTE)).toHaveCount(0);
      await ctx.close();
    });
  }

  test('a theme change swaps the file in the same element, keeps a paused video paused at the same time and keeps rate, volume, mute and captions', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await ctx.newPage();
    await login(page);
    await open(page);
    await expect.poll(async () => (await snapshot(page)).track).toBe('showing');
    await video(page).evaluate((v: HTMLVideoElement) => {
      (window as unknown as { __video: HTMLVideoElement }).__video = v;
      v.currentTime = 1.2;
      v.playbackRate = 1.5;
      v.volume = 0.4;
      v.muted = true;
    });
    await expect.poll(async () => (await snapshot(page)).t).toBeCloseTo(1.2, 1);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => srcOf(page)).toBe(LIGHT_VIDEO);
    await expect.poll(async () => (await snapshot(page)).ready).toBeGreaterThanOrEqual(2);
    await expect.poll(async () => Math.abs((await snapshot(page)).t - 1.2)).toBeLessThan(0.25);
    const after = await snapshot(page);
    expect(after).toMatchObject({ paused: true, rate: 1.5, muted: true, track: 'showing' });
    expect(after.volume).toBeCloseTo(0.4, 2);
    expect(await video(page).evaluate((v) => v === (window as unknown as { __video: HTMLVideoElement }).__video)).toBe(true);
    await ctx.close();
  });

  test('a playing video keeps playing from about the same place after the swap, and back again', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await ctx.newPage();
    await login(page);
    await open(page);
    // Slow it down so the 2 second clip is still running when the swap is done.
    await video(page).evaluate((v: HTMLVideoElement) => {
      v.playbackRate = 0.25;
      v.loop = true;
      return v.play();
    });
    await expect.poll(async () => (await snapshot(page)).t).toBeGreaterThan(0.1);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => srcOf(page)).toBe(LIGHT_VIDEO);
    await expect.poll(async () => (await snapshot(page)).paused, { timeout: 8000 }).toBe(false);
    expect((await snapshot(page)).rate).toBe(0.25);
    await expect.poll(async () => (await snapshot(page)).t).toBeGreaterThan(0);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => srcOf(page)).toBe(DARK_VIDEO);
    await expect.poll(async () => (await snapshot(page)).paused, { timeout: 8000 }).toBe(false);
    await ctx.close();
  });

  test('the freeze-frame cover is out of the way once the new file shows a frame', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await ctx.newPage();
    await login(page);
    await open(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => srcOf(page)).toBe(LIGHT_VIDEO);
    const cover = page.locator('.tut__freeze');
    await expect(cover).toHaveAttribute('data-state', 'off');
    await expect.poll(() => cover.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
    expect(await cover.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
    await ctx.close();
  });

  test('a light file that fails to load reverts to the dark one at the same time and says so', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await ctx.newPage();
    await login(page);
    await page.route('**/demo-tour-light.mp4', (route) => route.abort());
    await open(page);
    await video(page).evaluate((v: HTMLVideoElement) => {
      v.currentTime = 1;
    });
    await expect.poll(async () => (await snapshot(page)).t).toBeCloseTo(1, 1);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.getByText('The light video could not be loaded; showing the dark video.')).toBeVisible();
    await expect.poll(() => srcOf(page)).toBe(DARK_VIDEO);
    await expect.poll(async () => Math.abs((await snapshot(page)).t - 1)).toBeLessThan(0.25);
    await expect.poll(async () => (await snapshot(page)).ready).toBeGreaterThanOrEqual(2);
    // A later switch to dark and back tries again instead of staying on the failure.
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => theme(page)).toBe('dark');
    await ctx.close();
  });

  test('a tutorial without a light recording says so in the light theme and plays the dark one', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'light' });
    const page = await ctx.newPage();
    await login(page);
    await open(page, '/tutorials?t=second-tour');
    expect(await srcOf(page)).toBe('/api/tutorials/second-tour/media/second.mp4');
    await expect(page.getByText(NOTE)).toBeVisible();
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.getByText(NOTE)).toHaveCount(0);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.getByText(NOTE)).toBeVisible();
    expect(await srcOf(page)).toBe('/api/tutorials/second-tour/media/second.mp4');
    await ctx.close();
  });

  for (const scheme of ['dark', 'light'] as const) {
    test(`has no serious accessibility violations in the ${scheme} theme`, async ({ browser }) => {
      const ctx = await browser.newContext({ colorScheme: scheme });
      const page = await ctx.newPage();
      await login(page);
      await open(page);
      const axe = await (await axeBuilder(page)).analyze();
      const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
      await ctx.close();
    });
  }
});

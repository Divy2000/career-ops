/// <reference lib="dom" />
import { test, expect, type Page } from '@playwright/test';
import { axeBuilder } from './helpers.js';
import { E2E_TOKEN } from '../../playwright.config.js';

const PARTS = '/tutorials?t=parts-tour';
const media = (name: string) => `/api/tutorials/parts-tour/media/${name}`;

async function login(page: Page) {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

const video = (page: Page) => page.locator('video');
const srcOf = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => new URL(v.currentSrc || v.src).pathname);
const state = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => ({ t: v.currentTime, paused: v.paused, ended: v.ended, ready: v.readyState, duration: v.duration }));
const parts = (page: Page) => page.getByRole('complementary', { name: 'Parts' });
const partRow = (page: Page, label: string) => parts(page).getByRole('link', { name: new RegExp(label) });
const upNext = (page: Page) => page.getByRole('group', { name: /Up next/ });

async function open(page: Page, query = '') {
  await page.goto(`${PARTS}${query}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Tutorials' })).toBeVisible();
  await expect(video(page)).toBeVisible();
  await expect.poll(async () => (await state(page)).ready).toBeGreaterThanOrEqual(1);
}

/** Jumps to just before the end of the part that is showing and plays the rest. */
async function playToEnd(page: Page) {
  await video(page).evaluate((v: HTMLVideoElement) => {
    v.currentTime = Math.max(0, v.duration - 0.3);
    return v.play();
  });
}

async function axeClean(page: Page) {
  const axe = await (await axeBuilder(page)).analyze();
  const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
}

test.describe('Tutorials in parts', () => {
  test.use({ colorScheme: 'dark' });
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('?part=b opens b: its video, its chapters and the current marker on b', async ({ page }) => {
    await open(page, '&part=b');
    expect(await srcOf(page)).toBe(media('b.mp4'));
    await expect(partRow(page, 'Today & inbox')).toHaveAttribute('aria-current', 'true');
    await expect(partRow(page, 'Start here')).not.toHaveAttribute('aria-current', 'true');
    const chapters = parts(page).getByRole('button');
    await expect(chapters).toHaveText([/0:00\s*Today/, /0:01\s*Pipeline/]);
    await expect(parts(page).getByRole('button', { name: /Today/ })).toHaveAttribute('aria-current', 'true');
    await expect(page.getByText('Part 2 of 3', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Today and the inbox' })).toBeVisible();
  });

  test('an unknown part opens the first one', async ({ page }) => {
    await open(page, '&part=nope');
    expect(await srcOf(page)).toBe(media('a.mp4'));
    await expect(partRow(page, 'Start here')).toHaveAttribute('aria-current', 'true');
  });

  test('lists every part with its number, label and length, and the full title as a tooltip', async ({ page }) => {
    await open(page);
    await expect(parts(page).getByRole('heading', { level: 2, name: 'Parts' })).toBeVisible();
    await expect(parts(page).locator('.tut-part__row')).toHaveText([/1\s*Start here\s*0:30/, /2\s*Today & inbox\s*0:02/, /3\s*Tracker\s*0:02/]);
    await expect(partRow(page, 'Tracker')).toHaveAttribute('title', 'The tracker');
    await expect(page.getByRole('complementary', { name: 'Chapters' })).toHaveCount(0);
  });

  test('choosing a part opens it and pushes a history entry, so Back returns to the previous part', async ({ page }) => {
    await open(page);
    await partRow(page, 'Tracker').click();
    await expect(page).toHaveURL(/part=c/);
    await expect.poll(() => srcOf(page)).toBe(media('c.mp4'));
    await page.goBack();
    await expect(page).not.toHaveURL(/part=c/);
    await expect.poll(() => srcOf(page)).toBe(media('a.mp4'));
  });

  test('when part a ends, Up next names b, and Escape keeps part a', async ({ page }) => {
    await open(page, '&part=a');
    await playToEnd(page);
    await expect(upNext(page)).toBeVisible();
    await expect(upNext(page)).toContainText('Today and the inbox');
    await expect(upNext(page)).toContainText('Part 2 of 3');
    await page.keyboard.press('Escape');
    await expect(upNext(page)).toHaveCount(0);
    await expect(page).toHaveURL(/part=a/);
    expect(await srcOf(page)).toBe(media('a.mp4'));
  });

  test('Play now opens b and plays it from the start', async ({ page }) => {
    await open(page, '&part=a');
    await playToEnd(page);
    await upNext(page).getByRole('button', { name: 'Play now' }).click();
    await expect(page).toHaveURL(/part=b/);
    await expect.poll(() => srcOf(page)).toBe(media('b.mp4'));
    await expect.poll(async () => (await state(page)).paused).toBe(false);
    expect((await state(page)).t).toBeLessThan(1.5);
  });

  test('the countdown opens b by itself', async ({ page }) => {
    await open(page, '&part=a');
    await playToEnd(page);
    await expect(upNext(page)).toBeVisible();
    await expect(page).toHaveURL(/part=b/, { timeout: 12_000 });
    await expect.poll(() => srcOf(page)).toBe(media('b.mp4'));
  });

  test('a theme change during the Up next prompt keeps the prompt, and its countdown still opens b', async ({ page }) => {
    await open(page, '&part=a');
    await playToEnd(page);
    await expect(upNext(page)).toBeVisible();
    const secondsLeft = async () => Number(/(\d+) s/.exec((await upNext(page).locator('.tut-upnext__count').textContent()) ?? '')?.[1]);
    await expect.poll(secondsLeft).toBeLessThanOrEqual(6);
    const before = await secondsLeft();
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => srcOf(page)).toBe(media('a-light.mp4'));
    await expect.poll(async () => (await state(page)).ready).toBeGreaterThanOrEqual(2);
    await expect(page.locator('.tut__freeze')).toHaveAttribute('data-state', 'off');
    await expect(upNext(page)).toBeVisible();
    expect(await secondsLeft()).toBeLessThanOrEqual(before);
    await expect(page).toHaveURL(/part=b/, { timeout: 12_000 });
    await expect.poll(() => srcOf(page)).toBe(media('b-light.mp4'));
  });

  test('the last part ending shows no prompt', async ({ page }) => {
    await open(page, '&part=c');
    await playToEnd(page);
    await expect.poll(async () => (await state(page)).ended).toBe(true);
    await expect(upNext(page)).toHaveCount(0);
    await expect(partRow(page, 'Tracker')).toContainText('watched');
  });

  test('a theme change inside a part swaps to that part\'s light file at the same time', async ({ page }) => {
    await open(page, '&part=b');
    await expect.poll(async () => (await state(page)).ready).toBeGreaterThanOrEqual(2);
    await video(page).evaluate((v: HTMLVideoElement) => {
      v.currentTime = 1.2;
    });
    await expect.poll(async () => (await state(page)).t).toBeCloseTo(1.2, 1);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => srcOf(page)).toBe(media('b-light.mp4'));
    await expect.poll(async () => (await state(page)).ready).toBeGreaterThanOrEqual(2);
    await expect.poll(async () => Math.abs((await state(page)).t - 1.2)).toBeLessThan(0.25);
    await expect(video(page)).toHaveAttribute('poster', media('b-poster-light.jpg'));
  });

  test('Watch in video on a guide subsection whose chapter is in part c opens c at that chapter', async ({ page }) => {
    await page.goto(`${PARTS}&view=guide&section=basics&sub=detail`);
    const detail = page.getByRole('region', { name: 'Application detail', exact: true });
    await detail.getByRole('button', { name: 'Watch in video' }).click();
    await expect(page).toHaveURL(/part=c/);
    await expect(page).not.toHaveURL(/view=guide/);
    await expect.poll(() => srcOf(page)).toBe(media('c.mp4'));
    await expect.poll(async () => (await state(page)).t).toBeCloseTo(1, 1);
    await expect(parts(page).getByRole('button', { name: /Application detail/ })).toHaveAttribute('aria-current', 'true');
  });

  test('progress is kept: part a at half way shows about 50% after a reload, and opening it resumes there', async ({ page }) => {
    await open(page, '&part=a');
    await video(page).evaluate(async (v: HTMLVideoElement) => {
      v.currentTime = 15;
      await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      await v.play();
      v.pause();
    });
    await page.goto(`${PARTS}&part=b`);
    await expect(partRow(page, 'Start here')).toContainText('50% watched');
    await expect.poll(() => partRow(page, 'Start here').locator('.tut-part__fill').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a)).toBeCloseTo(0.5, 1);
    await partRow(page, 'Start here').click();
    await expect.poll(() => srcOf(page)).toBe(media('a.mp4'));
    await expect.poll(async () => (await state(page)).t).toBeCloseTo(15, 0);
  });

  test('a tutorial with one video keeps its Chapters panel and shows no part controls', async ({ page }) => {
    await page.goto('/tutorials?t=demo-tour');
    await expect(page.getByRole('complementary', { name: 'Chapters' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Parts' })).toHaveCount(0);
    await expect(page.getByText(/^Part \d+ of \d+$/)).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: 'Demo tour' })).toBeVisible();
  });

  for (const colorScheme of ['dark', 'light'] as const) {
    test(`has no serious accessibility violations in ${colorScheme}, with the Up next prompt showing`, async ({ page }) => {
      // Reduced motion: the countdown bar is a finite animation, which the axe helper would wait out.
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await open(page, '&part=a');
      await axeClean(page);
      await playToEnd(page);
      await expect(upNext(page)).toBeVisible();
      await axeClean(page);
    });
  }
});

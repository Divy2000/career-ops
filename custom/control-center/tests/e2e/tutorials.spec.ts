import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import { axeBuilder } from './helpers.js';
import { E2E_PORT, E2E_TOKEN } from '../../playwright.config.js';

async function login(page: Page) {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

async function axeClean(page: Page) {
  const axe = await (await axeBuilder(page)).analyze();
  const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
}

const video = (page: Page) => page.locator('video');
const state = (page: Page) =>
  video(page).evaluate((v: HTMLVideoElement) => ({ paused: v.paused, time: v.currentTime, duration: v.duration, track: v.textTracks[0]?.mode ?? null, cues: v.textTracks[0]?.cues?.length ?? 0, ready: v.readyState }));

test.describe('Tutorials', () => {
  // The dark recording and poster are the ones under test here; tutorial-theme.spec.ts covers the light ones.
  test.use({ colorScheme: 'dark' });
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/tutorials');
    await expect(page.getByRole('heading', { level: 1, name: 'Tutorials' })).toBeVisible();
    await expect(video(page)).toBeVisible();
    await expect.poll(async () => (await state(page)).ready).toBeGreaterThanOrEqual(1);
  });

  test('is reachable from the sidebar and the command palette', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Tutorials' }).click();
    await expect(page).toHaveURL(/\/tutorials$/);
    await page.goto('/');
    await page.getByRole('button', { name: 'Open command palette' }).click();
    await page.getByPlaceholder('Go to a page, run an action or start a mode').fill('Tutorials');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/tutorials$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Tutorials' })).toBeVisible();
  });

  test('lists the tutorials with a poster thumbnail, selects one and warns about a broken folder', async ({ page }) => {
    const list = page.getByRole('navigation', { name: 'Tutorials' });
    await expect(list.getByRole('link', { name: /Demo tour/ })).toHaveAttribute('aria-current', 'true');
    await expect(list.getByRole('link', { name: /Second tour/ })).toBeVisible();
    const thumb = list.locator('img').first();
    await expect(thumb).toHaveAttribute('src', '/api/tutorials/demo-tour/media/poster.jpg');
    await expect.poll(() => thumb.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    await expect(video(page)).toHaveAttribute('poster', '/api/tutorials/demo-tour/media/poster.jpg');
    await expect(page.getByText('1 tutorial folder was skipped')).toBeVisible();
    await expect(page.getByText('broken-demo', { exact: true })).toBeVisible();
    await expect(page.getByText(/not valid JSON/)).toBeVisible();
    await list.getByRole('link', { name: /Second tour/ }).click();
    await expect(page).toHaveURL(/t=second-tour/);
    await expect(page.getByRole('heading', { level: 2, name: 'Second tour' })).toBeVisible();
    await expect(page.getByText('This tutorial has no chapters.')).toBeVisible();
    await axeClean(page);
  });

  test('plays and pauses with the keyboard and the highlighted chapter follows the playhead', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Intro/ })).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('k');
    await expect.poll(async () => (await state(page)).paused).toBe(false);
    await expect(page.getByRole('button', { name: /Middle/ })).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('Space');
    await expect.poll(async () => (await state(page)).paused).toBe(true);
    const pausedAt = (await state(page)).time;
    expect(pausedAt).toBeGreaterThan(0);
    await page.keyboard.press(' ');
    await expect.poll(async () => (await state(page)).paused).toBe(false);
    await page.keyboard.press('k');
  });

  test('jumps 10 seconds with j and l, clamped to the clip', async ({ page }) => {
    await page.keyboard.press('l');
    await expect.poll(async () => (await state(page)).time).toBeCloseTo((await state(page)).duration, 0);
    await page.keyboard.press('j');
    await expect.poll(async () => (await state(page)).time).toBe(0);
  });

  test('clicking a chapter seeks to it, with its timestamp listed, and the arrow keys move between chapters', async ({ page }) => {
    const chapters = page.getByRole('complementary', { name: 'Chapters' });
    await expect(chapters.getByRole('button')).toHaveCount(3);
    await expect(chapters.getByRole('button', { name: /^0:00 Intro/ })).toBeVisible();
    await expect(chapters.getByRole('button', { name: /^0:01 Outro/ })).toBeVisible();
    await chapters.getByRole('button', { name: /Middle/ }).click();
    await expect.poll(async () => (await state(page)).time).toBeCloseTo(0.5, 1);
    await expect(chapters.getByRole('button', { name: /Middle/ })).toHaveAttribute('aria-current', 'true');
    expect((await state(page)).paused).toBe(true);
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await state(page)).time).toBeCloseTo(1.5, 1);
    await expect(chapters.getByRole('button', { name: /Outro/ })).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(chapters.getByRole('button', { name: /Outro/ })).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect.poll(async () => (await state(page)).time).toBe(0);
    await expect(chapters.getByRole('button', { name: /Intro/ })).toHaveAttribute('aria-current', 'true');
  });

  test('keys still work with the video itself focused (no double handling by the native controls)', async ({ page }) => {
    await video(page).focus();
    await page.keyboard.press('Space');
    await expect.poll(async () => (await state(page)).paused).toBe(false);
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('button', { name: /Middle/ })).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('k');
    await expect.poll(async () => (await state(page)).paused).toBe(true);
  });

  test('the subtitles are converted from srt, shown by default and toggled by c and by the button, and the choice is remembered', async ({ page }) => {
    await expect.poll(async () => (await state(page)).track).toBe('showing');
    await expect.poll(async () => (await state(page)).cues).toBe(2);
    const toggle = page.getByRole('button', { name: /^Captions:/ });
    await expect(toggle).toHaveText('Captions: on');
    await page.keyboard.press('c');
    await expect(toggle).toHaveText('Captions: off');
    await expect.poll(async () => (await state(page)).track).toBe('disabled');
    await toggle.click();
    await expect(toggle).toHaveText('Captions: on');
    await expect.poll(async () => (await state(page)).track).toBe('showing');
    await page.keyboard.press('c');
    await expect.poll(async () => (await state(page)).track).toBe('disabled');
    await page.reload();
    await expect(page.getByRole('button', { name: /^Captions:/ })).toHaveText('Captions: off');
    await expect.poll(async () => (await state(page)).track).toBe('disabled');
  });

  test('the transcript is collapsible and searchable and shortcut keys do not fire while typing in it', async ({ page }) => {
    await expect(page.getByText('Welcome to the demo.')).toHaveCount(0);
    const open = page.getByRole('button', { name: /Transcript/ });
    await expect(open).toHaveAttribute('aria-expanded', 'false');
    await open.click();
    await expect(open).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('Welcome to the demo. The shortlist lives on Today.')).toBeVisible();
    await expect(page.getByText('title card')).toHaveCount(0);
    const search = page.getByLabel('Search the transcript');
    await search.fill('shortlist');
    await expect(page.getByRole('status').filter({ hasText: '1 match' })).toBeVisible();
    await expect(page.getByText('Welcome to the demo. The shortlist lives on Today.')).toBeVisible();
    await search.fill('tracker');
    await expect(page.getByRole('status').filter({ hasText: '1 match' })).toBeVisible();
    await expect(page.getByText('The tracker holds every application.')).toBeVisible();
    await expect(page.getByText('Welcome to the demo.')).toHaveCount(0);
    await search.fill('zebra');
    await expect(page.getByText('No matches.')).toBeVisible();
    await search.fill('');
    await search.press('k');
    await search.press('c');
    expect(await search.inputValue()).toBe('kc');
    const s = await state(page);
    expect(s.paused).toBe(true);
    expect(s.track).toBe('showing');
    await open.click();
    await expect(open).toHaveAttribute('aria-expanded', 'false');
    await axeClean(page);
  });

  test('the media route answers range requests through the app', async ({ page }) => {
    const res = await page.request.get('/api/tutorials/demo-tour/media/demo-tour.mp4', { headers: { range: 'bytes=0-99' } });
    expect(res.status()).toBe(206);
    expect(res.headers()['content-range']).toMatch(/^bytes 0-99\/\d+$/);
    expect(res.headers()['accept-ranges']).toBe('bytes');
    expect((await res.body()).length).toBe(100);
    expect((await page.request.get('/api/tutorials/demo-tour/media/demo-tour.mp4', { headers: { range: 'bytes=99999999-' } })).status()).toBe(416);
    expect((await page.request.get('/api/tutorials/demo-tour/media/..%2F..%2Fapplications.md')).status()).toBe(400);
    const cookieless = await (await page.context().browser()!.newContext()).request.get(`http://127.0.0.1:${E2E_PORT}/api/tutorials/demo-tour/media/demo-tour.mp4`);
    expect(cookieless.status()).toBe(401);
  });

  test('aborted range requests do not leave the media file open in the server (the proxy hands the abort on)', async ({ page }) => {
    const lsof = spawnSync('lsof', ['-v'], { stdio: 'ignore' });
    test.skip(lsof.error !== undefined, 'lsof is not installed');
    const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
    const serverPid = ((await (await page.request.get('/healthz')).json()) as { pid: number }).pid;
    const openCount = () => spawnSync('lsof', ['-p', String(serverPid)], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes('padding.mp4')).length;
    const abortedRequest = () =>
      new Promise<void>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: E2E_PORT, path: '/api/tutorials/demo-tour/media/padding.mp4', headers: { cookie, range: 'bytes=0-' } }, (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        });
        req.on('error', (err) => ((err as NodeJS.ErrnoException).code === 'ECONNRESET' ? resolve() : reject(err)));
      });
    for (let i = 0; i < 8; i++) await abortedRequest();
    await expect.poll(openCount, { timeout: 10_000 }).toBe(0);
  });
});

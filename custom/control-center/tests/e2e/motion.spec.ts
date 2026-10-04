/// <reference lib="dom" />
import { test, expect, type Page } from '@playwright/test';
import { E2E_TOKEN } from '../../playwright.config.js';
import { waitForAnimations } from './helpers.js';

async function login(page: Page) {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

const switcher = (page: Page) => page.getByRole('button', { name: /^Theme:/ });
const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);

/** Counts startViewTransition calls and records the clip-path keyframes of the circular reveal. */
const SPY = () => {
  const w = window as unknown as { __vt: number; __reveal: Array<{ clipPath: string[]; duration: number; pseudo: string | undefined }> };
  w.__vt = 0;
  w.__reveal = [];
  const doc = document as unknown as { startViewTransition?: (cb: () => void) => unknown };
  const original = doc.startViewTransition?.bind(document);
  if (original) {
    doc.startViewTransition = (cb) => {
      w.__vt++;
      return original(cb);
    };
  }
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
    const o = typeof options === 'object' ? (options as KeyframeAnimationOptions & { pseudoElement?: string }) : undefined;
    if (o?.pseudoElement === '::view-transition-new(root)') w.__reveal.push({ clipPath: (keyframes as { clipPath: string[] }).clipPath, duration: Number(o.duration), pseudo: o.pseudoElement });
    return animate.call(this, keyframes as Keyframe[], options);
  };
};

test.describe('theme change motion', () => {
  test('a user choice reveals the new theme with one view transition, a circle that starts at the button center', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await ctx.addInitScript(SPY);
    await login(page);
    const box = (await switcher(page).boundingBox())!;
    const cx = Math.round(box.x + box.width / 2);
    const cy = Math.round(box.y + box.height / 2);
    await switcher(page).click();
    await page.getByRole('menuitemradio', { name: 'Light' }).click();
    await expect.poll(() => theme(page)).toBe('light');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __reveal: unknown[] }).__reveal.length)).toBe(1);
    const spy = await page.evaluate(() => ({ vt: (window as unknown as { __vt: number }).__vt, reveal: (window as unknown as { __reveal: Array<{ clipPath: string[]; duration: number }> }).__reveal }));
    expect(spy.vt).toBe(1);
    const [from, to] = spy.reveal[0]!.clipPath as [string, string];
    expect(from).toMatch(new RegExp(`^circle\\(0px at (${cx}|${cx - 1}|${cx + 1})(\\.\\d+)?px (${cy}|${cy - 1}|${cy + 1})(\\.\\d+)?px\\)$`));
    // Farthest corner from the top right of a 1440x900 viewport is the bottom left.
    const radius = Math.hypot(Math.max(cx, 1440 - cx), Math.max(cy, 900 - cy));
    expect(Number(/circle\(([\d.]+)px/.exec(to)![1])).toBeCloseTo(radius, -1);
    expect(spy.reveal[0]!.duration).toBe(520);
    await waitForAnimations(page);
    await ctx.close();
  });

  test('with reduced motion the theme changes at once: no view transition, no reveal', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark', reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await ctx.addInitScript(SPY);
    await login(page);
    await switcher(page).click();
    await page.getByRole('menuitemradio', { name: 'Light' }).click();
    expect(await theme(page)).toBe('light');
    const spy = await page.evaluate(() => ({ vt: (window as unknown as { __vt: number }).__vt, reveal: (window as unknown as { __reveal: unknown[] }).__reveal.length, fading: document.documentElement.classList.contains('theme-fading') }));
    expect(spy).toEqual({ vt: 0, reveal: 0, fading: false });
    await ctx.close();
  });

  test('an OS flip under Auto fades colors instead of revealing', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await ctx.newPage();
    await ctx.addInitScript(SPY);
    await login(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => theme(page)).toBe('light');
    expect(await page.evaluate(() => (window as unknown as { __vt: number }).__vt)).toBe(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('theme-fading'))).toBe(false);
    await ctx.close();
  });
});

test.describe('page and overlay motion', () => {
  test.beforeEach(async ({ page }) => login(page));

  test('a page enters with a short rise and leaves no transform behind (no containing block for fixed children)', async ({ page }) => {
    await page.getByRole('link', { name: 'Tracker' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tracker' })).toBeVisible();
    const name = await page.locator('.shell__main > section').first().evaluate((el) => getComputedStyle(el).animationName);
    expect(['rise', 'none']).toContain(name);
    await waitForAnimations(page);
    expect(await page.locator('.shell__main > section').first().evaluate((el) => getComputedStyle(el).transform)).toBe('none');
  });

  test('the palette and dialogs animate in but vanish at once on close', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const palette = page.locator('.palette');
    await expect(palette).toBeVisible();
    expect(await palette.evaluate((el) => getComputedStyle(el).animationName)).toBe('palette-in');
    await waitForAnimations(page);
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0, { timeout: 250 });
    await expect(page.locator('.dialog__overlay')).toHaveCount(0, { timeout: 250 });
  });

  test('buttons give press feedback', async ({ page }) => {
    const ask = page.getByRole('button', { name: 'Open Ask drawer' });
    await ask.hover();
    await page.mouse.down();
    await expect.poll(() => ask.evaluate((el) => getComputedStyle(el).transform)).toBe('matrix(0.98, 0, 0, 0.98, 0, 0)');
    // Releasing the press is a click, which opens the drawer; close it again.
    await page.mouse.up();
    await page.keyboard.press('Escape');
  });
});

test.describe('hover lift', () => {
  for (const [scheme, expected] of [
    ['light', 'matrix(1, 0, 0, 1, 0, -1)'],
    ['dark', 'matrix(1, 0, 0, 1, 0, 0)'],
  ] as const) {
    test(`a tutorial card ${scheme === 'light' ? 'rises 1px' : 'stays put and glows'} on hover in the ${scheme} theme`, async ({ browser }) => {
      const ctx = await browser.newContext({ colorScheme: scheme });
      const page = await ctx.newPage();
      await login(page);
      await page.goto('/tutorials');
      const card = page.locator('.tut-card').first();
      await expect(card).toBeVisible();
      await waitForAnimations(page);
      await card.hover();
      await expect.poll(() => card.evaluate((el) => getComputedStyle(el).transform)).toBe(expected);
      await expect.poll(() => card.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
      await ctx.close();
    });
  }
});

test.describe('skeleton shimmer', () => {
  test('shimmers for people who allow motion', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);
    await page.route('**/api/**', async (route) => {
      await new Promise((r) => setTimeout(r, 800));
      await route.continue();
    });
    await page.goto('/tracker');
    const line = page.locator('.skeleton__line').first();
    await expect(line).toBeVisible();
    expect(await line.evaluate((el) => getComputedStyle(el).animationName)).toBe('shimmer');
    await ctx.close();
  });

  test('is static with reduced motion', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await login(page);
    await page.route('**/api/**', async (route) => {
      await new Promise((r) => setTimeout(r, 800));
      await route.continue();
    });
    await page.goto('/tracker');
    const line = page.locator('.skeleton__line').first();
    await expect(line).toBeVisible();
    const css = await line.evaluate((el) => ({ name: getComputedStyle(el).animationName, image: getComputedStyle(el).backgroundImage }));
    expect(css).toEqual({ name: 'none', image: 'none' });
    await ctx.close();
  });
});

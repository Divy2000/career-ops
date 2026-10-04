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

  for (const [name, status, sessions, shortLabels, title] of [
    ['setup needs attention and twelve running sessions', { code: 200, token: false }, Array.from({ length: 12 }, () => ({ status: 'running' })), ['12 run', 'Setup !'], /12 running/],
    ['status unavailable and sessions waiting for you', { code: 500, token: true }, [{ status: 'awaiting_user' }, { status: 'awaiting_user' }], ['2 wait', 'Setup ?'], /2 waiting for you/],
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
      // A failing status request is retried once before the chip settles on its error state.
      if (status.code !== 200) await expect(page.locator('span.chip--danger[data-short="Setup ?"]')).toBeAttached();
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
      const shown = await page.evaluate(() => [...document.querySelectorAll('.shell__top .chip[data-short]')].filter((el) => el.getBoundingClientRect().width > 0).map((el) => /^"([^"]*)"/.exec(getComputedStyle(el, '::after').content)?.[1]));
      expect(shown).toEqual([...shortLabels]);
      await expect(page.getByRole('link', { name: /^Activity:/ })).toHaveAttribute('title', title);
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

  test('opening Ask while the drawer is open closes the drawer and Tab does not return focus to it', async ({ page }) => {
    await menuButton(page).click();
    await expect(sidebar(page)).toBeVisible();
    await page.getByRole('button', { name: 'Open Ask drawer' }).click();
    await expect(page.getByRole('dialog', { name: 'Ask' })).toBeVisible();
    await expect(sidebar(page)).toBeHidden();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.querySelector('#primary-nav')!.contains(document.activeElement))).toBe(false);
  });

  test('opening the command palette while the drawer is open closes the drawer and focus stays in the palette', async ({ page }) => {
    await menuButton(page).click();
    await expect(sidebar(page)).toBeVisible();
    await page.getByRole('button', { name: 'Open command palette' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('.shell')).not.toHaveClass(/shell--nav-open/);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  });

  test('widening the window past the breakpoint does not try to move focus to the hidden menu button', async ({ page }) => {
    await menuButton(page).click();
    await expect(sidebar(page).getByRole('link', { name: 'Today' })).toBeFocused();
    await page.evaluate(() => {
      const w = window as unknown as { __menuFocusCalls: number };
      w.__menuFocusCalls = 0;
      const btn = document.querySelector('.menu-toggle') as HTMLElement;
      const orig = btn.focus.bind(btn);
      btn.focus = (...a: Parameters<HTMLElement['focus']>) => {
        w.__menuFocusCalls++;
        orig(...a);
      };
    });
    await page.setViewportSize({ width: 1000, height: 844 });
    await expect(menuButton(page)).toBeHidden();
    await expect(sidebar(page).getByRole('link', { name: 'Today' })).toBeFocused();
    expect(await page.evaluate(() => (window as unknown as { __menuFocusCalls: number }).__menuFocusCalls)).toBe(0);
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
    await expect(menuButton(page)).toBeHidden();
    // The breakpoint listener fires on a rendering update; narrowing before one runs would mean the page never left the narrow range.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
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

/** The invariant: focus is never left on an element that is hidden (display none, hidden ancestor, zero size). The page body counts as visible. */
async function expectFocusRendered(page: Page, step: string) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const a = document.activeElement;
          if (!a || a === document.body) return 'body';
          const r = a.getBoundingClientRect();
          const rendered = (a as HTMLElement).checkVisibility({ checkVisibilityCSS: true }) && r.width > 0 && r.height > 0;
          return rendered ? 'rendered' : `hidden <${a.tagName.toLowerCase()}> "${(a.textContent ?? '').trim().slice(0, 30)}"`;
        }),
      { message: `focus after: ${step}` },
    )
    .toMatch(/^(body|rendered)$/);
}

const insideOverlay = (page: Page, which: 'ask' | 'palette') =>
  page.evaluate((w) => !!document.activeElement?.closest(w === 'ask' ? '[role="dialog"][aria-label="Ask"]' : '[role="dialog"]'), which);

test.describe('focus is never left on a hidden element (390 <-> 1000)', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test.beforeEach(async ({ page }) => login(page));

  async function resizeRoundTrip(page: Page, step: string) {
    // A modal overlay hides the rest of the page from the role tree, so the menu button is found by class here.
    const menuToggle = page.locator('.menu-toggle');
    await page.setViewportSize({ width: 1000, height: 844 });
    await expect(menuToggle).toBeHidden();
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await expectFocusRendered(page, `${step}, widened`);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(menuToggle).toBeVisible();
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await expectFocusRendered(page, `${step}, narrowed again`);
  }

  for (const drawerOpen of [false, true]) {
    for (const resizeFirst of [false, true]) {
      for (const [overlay, via] of [['ask', 'button'], ['ask', 'hotkey'], ['palette', 'button'], ['palette', 'hotkey']] as const) {
        test(`drawer ${drawerOpen ? 'open' : 'closed'}, resize ${resizeFirst ? 'before' : 'after'}, ${overlay} by ${via}`, async ({ page }) => {
          if (drawerOpen) {
            await menuButton(page).click();
            await expect(sidebar(page)).toBeVisible();
            await expectFocusRendered(page, 'drawer opened');
          }
          if (resizeFirst) await resizeRoundTrip(page, 'before the overlay');
          if (drawerOpen && resizeFirst) {
            await menuButton(page).click();
            await expect(sidebar(page)).toBeVisible();
            await sidebar(page).getByRole('link', { name: 'Today' }).focus();
          }

          if (overlay === 'ask') {
            if (via === 'button') await page.getByRole('button', { name: 'Open Ask drawer' }).click();
            else await page.keyboard.press('Control+j');
            await expect(page.getByRole('dialog', { name: 'Ask' })).toBeVisible();
          } else {
            if (via === 'button') await page.getByRole('button', { name: 'Open command palette' }).click();
            else await page.keyboard.press('Control+k');
            await expect(page.getByRole('dialog')).toBeVisible();
          }
          await expectFocusRendered(page, 'overlay opened');
          await expect.poll(() => insideOverlay(page, overlay), { message: 'focus moved into the overlay' }).toBe(true);
          await expect(page.locator('.shell')).not.toHaveClass(/shell--nav-open/);

          await resizeRoundTrip(page, 'overlay open');

          if (overlay === 'ask' && via === 'button') await page.getByRole('button', { name: 'Close Ask' }).click();
          else if (overlay === 'ask') await page.keyboard.press('Control+j');
          else await page.keyboard.press('Escape');
          await expect(page.getByRole('dialog')).toHaveCount(0);
          await expectFocusRendered(page, 'overlay closed');
          // Back to the opener: the button that was pressed, or for a hotkey Menu when the drawer was what had focus.
          if (via === 'button') await expect(page.getByRole('button', { name: overlay === 'ask' ? 'Open Ask drawer' : 'Open command palette' })).toBeFocused();
          else if (drawerOpen) await expect(page.locator('.menu-toggle')).toBeFocused();

          await resizeRoundTrip(page, 'overlay closed');
        });
      }
    }
  }

  test('drawer open with focus on a link: widen then narrow moves focus to Menu', async ({ page }) => {
    await menuButton(page).click();
    await expect(sidebar(page).getByRole('link', { name: 'Today' })).toBeFocused();
    await resizeRoundTrip(page, 'drawer open');
    await expect(menuButton(page)).toBeFocused();
  });
});

for (const width of [390, 1440]) {
  test.describe(`overlays exclude each other at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });
    test.beforeEach(async ({ page }) => login(page));

    const ask = (page: Page) => page.getByRole('dialog', { name: 'Ask' });
    const palette = (page: Page) => page.locator('[role="dialog"]:not([aria-label="Ask"])');
    const opener = (page: Page) => page.locator('button[aria-label="Open command palette"]');
    const focusedInside = (page: Page, selector: string) => page.evaluate((sel) => !!document.activeElement?.closest(sel), selector);

    test('Ctrl+K then Ctrl+J swaps the palette for Ask and closing returns focus to the original opener', async ({ page }) => {
      await opener(page).focus();
      await page.keyboard.press('Control+k');
      await expect(palette(page)).toBeVisible();
      await page.keyboard.press('Control+j');
      await expect(ask(page)).toBeVisible();
      await expect(palette(page)).toHaveCount(0);
      await expect.poll(() => focusedInside(page, '[role="dialog"][aria-label="Ask"]')).toBe(true);
      await page.keyboard.press('Control+j');
      await expect(ask(page)).toHaveCount(0);
      await expect(opener(page)).toBeFocused();
    });

    test('Ctrl+J then Ctrl+K swaps Ask for the palette and closing returns focus to the original opener', async ({ page }) => {
      await opener(page).focus();
      await page.keyboard.press('Control+j');
      await expect(ask(page)).toBeVisible();
      await page.keyboard.press('Control+k');
      await expect(palette(page)).toBeVisible();
      await expect(ask(page)).toHaveCount(0);
      await expect.poll(() => focusedInside(page, '[role="dialog"]')).toBe(true);
      await page.keyboard.press('Escape');
      await expect(palette(page)).toHaveCount(0);
      await expect(opener(page)).toBeFocused();
    });
  });
}

test.describe('overlays exclude each other with the drawer open (390px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test.beforeEach(async ({ page }) => login(page));

  test('Ctrl+K then Ctrl+J then closing lands on Menu, the opener the drawer implied', async ({ page }) => {
    await menuButton(page).click();
    await expect(sidebar(page).getByRole('link', { name: 'Today' })).toBeFocused();
    await page.keyboard.press('Control+k');
    await expect(page.locator('[role="dialog"]:not([aria-label="Ask"])')).toBeVisible();
    await page.keyboard.press('Control+j');
    await expect(page.getByRole('dialog', { name: 'Ask' })).toBeVisible();
    await expect(page.locator('[role="dialog"]:not([aria-label="Ask"])')).toHaveCount(0);
    await page.keyboard.press('Control+j');
    await expect(page.getByRole('dialog', { name: 'Ask' })).toHaveCount(0);
    await expect(page.locator('.menu-toggle')).toBeFocused();
  });
});

test.describe('overlay hotkeys stay out of a parameter dialog', () => {
  test.beforeEach(async ({ page }) => login(page));

  for (const hotkey of ['Control+j', 'Control+k']) {
    test(`${hotkey} does nothing while the delete dialog opened from the palette is up`, async ({ page }) => {
      await page.keyboard.press('Control+k');
      const input = page.getByPlaceholder('Go to a page, run an action or start a mode');
      await input.fill('tracker.delete');
      await page.keyboard.press('Enter');
      const dialog = page.locator('[role="dialog"].dialog');
      await expect(dialog).toBeVisible();
      await page.keyboard.press(hotkey);
      await expect(page.getByRole('dialog', { name: 'Ask' })).toHaveCount(0);
      await expect(page.locator('[role="dialog"].palette')).toHaveCount(0);
      await expect(dialog).toBeVisible();
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"].dialog'))).toBe(true);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    });
  }
});

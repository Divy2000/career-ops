/// <reference lib="dom" />
import { test, expect, type Locator, type Page } from '@playwright/test';
import { axeBuilder, waitForAnimations } from './helpers.js';
import { E2E_TOKEN } from '../../playwright.config.js';

async function login(page: Page) {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

async function axeClean(page: Page) {
  const axe = await (await axeBuilder(page)).analyze();
  const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
}

const DOCS = '/tutorials?t=docs-tour&view=guide';
const LEGACY = '/tutorials?t=demo-tour&view=guide';
const toc = (page: Page) => page.getByRole('navigation', { name: 'Guide contents' });
const h2 = (page: Page, name: string) => page.getByRole('heading', { level: 2, name, exact: true });
const h3 = (page: Page, name: string) => page.getByRole('heading', { level: 3, name, exact: true });
const sub = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search the guide' });
const status = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });
const figure = (page: Page, caption: string) => page.locator('figure.doc-media', { hasText: caption });
const frameOf = (fig: Locator) => fig.locator('.doc-media__frame');

async function openDocs(page: Page, query = '') {
  await page.goto(`${DOCS}${query}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Tutorials' })).toBeVisible();
  await expect(page.locator('section.guide')).toBeVisible();
}

/** Distance of an element from the top of the scrolling page area, in px. */
const fromTop = (loc: Locator) => loc.evaluate((el) => el.getBoundingClientRect().top - (document.querySelector('.shell__main') as HTMLElement).getBoundingClientRect().top);
/** True once an element sits in the top band of the scroll area: below the edge, above the fold. Poll it: a smooth scroll takes a moment. */
const atTop = async (loc: Locator) => {
  const top = await fromTop(loc);
  return top >= -2 && top < 140;
};
const scrollTop = (page: Page) => page.evaluate(() => (document.querySelector('.shell__main') as HTMLElement).scrollTop);
const scrollSub = (page: Page, id: string) => page.evaluate((i) => document.querySelector(`[data-sub="${i}"]`)!.scrollIntoView({ block: 'start' }), id);

// Chromium starts a lazy image once it is within a distance of the viewport that grows with a slower connection (about 1250px on 4G, up to 8000px on slow-2g).
const LAZY_LOAD_MAX_DISTANCE = 8000;
/**
 * Pushes a subsection down by a fixed 10000px before the page loads, so an image inside it is out of lazy-load range whatever the fonts or text height.
 * Call it before `openDocs`: an image that starts inside the range is requested at once, and no later change takes that back.
 */
const pushSubDown = (page: Page, subId: string) =>
  page.addInitScript((id) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`.guide-doc [data-sub="${id}"] { margin-top: 10000px !important; }`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }, subId);
/** Pixels between the bottom of the viewport and the top of an element that is still below it. */
const belowViewport = (loc: Locator) => loc.evaluate((el) => el.getBoundingClientRect().top - window.innerHeight);
const historyLength = (page: Page) => page.evaluate(() => history.length);

test.describe('Tutorials guide, documentation style', () => {
  test.use({ colorScheme: 'dark' });
  test.beforeEach(async ({ page }) => {
    // CC_E2E_BLOCK_FONTS=1 reproduces a checkout where the web fonts cannot be served (fallback fonts lay the page out shorter), to prove no test leans on font metrics.
    if (process.env.CC_E2E_BLOCK_FONTS) await page.route(/\.(woff2?|ttf|otf)(\?|$)/, (route) => route.abort());
    await login(page);
  });

  test('a tutorial with a guide has a Video / Quick guide toggle that is kept in the URL, and one without has none', async ({ page }) => {
    await page.goto('/tutorials');
    const tabs = page.getByRole('tablist', { name: 'Tutorial view' });
    await expect(tabs.getByRole('tab', { name: 'Video' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('video')).toBeVisible();
    await tabs.getByRole('tab', { name: 'Quick guide' }).click();
    await expect(page).toHaveURL(/view=guide/);
    await expect(page.locator('video')).toHaveCount(0);
    await expect(h2(page, 'Today')).toBeVisible();
    await tabs.getByRole('tab', { name: 'Video' }).click();
    await expect(page).not.toHaveURL(/view=/);
    await expect(page.locator('video')).toBeVisible();

    await page.goto('/tutorials?t=second-tour');
    await expect(page.getByRole('heading', { level: 2, name: 'Second tour' })).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Tutorial view' })).toHaveCount(0);
    await page.goto('/tutorials?t=second-tour&view=guide');
    await expect(page.locator('video')).toBeVisible();
    await expect(toc(page)).toHaveCount(0);
  });

  test('switching tutorial drops the guide view', async ({ page }) => {
    await openDocs(page);
    await page.getByRole('navigation', { name: 'Tutorials' }).getByRole('link', { name: /Second tour/ }).click();
    await expect(page).toHaveURL(/t=second-tour/);
    await expect(page).not.toHaveURL(/view=/);
  });

  test('reads as documentation: a section with a lead, subsections with text, steps, a tip and a captioned figure', async ({ page }) => {
    await openDocs(page);
    await expect(page.getByText('Section 1 of 3')).toBeVisible();
    await expect(h2(page, 'Getting started')).toBeVisible();
    await expect(page.getByText('Launch the app and find your way around.')).toBeVisible();
    await expect(page.locator('.guide-doc h3')).toHaveText(['Launch and sign in', 'Safety model', 'Find your way around', 'Appearance']);
    const launch = sub(page, 'Launch and sign in');
    await expect(launch.getByText('Open the app with the token the launcher prints.')).toBeVisible();
    await expect(launch.getByText('Run the launcher, then open the printed link.')).toBeVisible();
    await expect(launch.getByRole('list', { name: 'Steps' }).getByRole('listitem')).toHaveText(['Open a terminal in the repo.', 'Run npm start.', 'Open the link it prints.']);
    await expect(launch.locator('figcaption')).toHaveText('Today, right after sign in.');
    await expect(sub(page, 'Safety model').getByLabel('Tip', { exact: true })).toContainText('Read the confirmation dialog before you accept.');
  });

  test('the contents have two levels: every section, and the subsections of the one being read', async ({ page }) => {
    await openDocs(page);
    await expect(toc(page).getByRole('link', { name: /^(Getting started|Tracking|Automation)/ })).toHaveCount(3);
    await expect(toc(page).getByRole('link', { name: /^Getting started/ })).toHaveAttribute('aria-current', 'true');
    await expect(toc(page).getByRole('list', { name: 'Getting started subsections' }).getByRole('link')).toHaveText(['Launch and sign in', 'Safety model', 'Layout', 'Appearance']);
    await expect(toc(page).getByRole('list', { name: 'Tracking subsections' })).toHaveCount(0);
    await toc(page).getByRole('link', { name: /^Tracking/ }).click();
    await expect(page).toHaveURL(/section=tracking/);
    await expect(h2(page, 'Tracking')).toBeVisible();
    await expect(toc(page).getByRole('list', { name: 'Tracking subsections' }).getByRole('link')).toHaveText(['Change a status', 'Follow-ups and replies', 'Safety of the data']);
    await expect(toc(page).getByRole('list', { name: 'Getting started subsections' })).toHaveCount(0);
  });

  test.describe('collapsible contents', () => {
    const toggle = (page: Page, name: string) => toc(page).getByRole('button', { name: `${name} subsections` });
    /** Height of every visible contents row, as [kind, px] pairs. */
    const rowHeights = (page: Page) =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.guide-toc__section, .guide-toc__sub')]
          .filter((el) => el.offsetParent !== null)
          .map((el) => [el.classList.contains('guide-toc__sub') ? 'sub' : 'section', Math.round(el.getBoundingClientRect().height)] as const),
      );

    test('shows the short label with the full title as a tooltip, while the heading keeps the full title', async ({ page }) => {
      await openDocs(page, '&section=getting-started&sub=navigate');
      await expect(toc(page).getByRole('link', { name: 'Layout', exact: true })).toHaveAttribute('title', 'Find your way around');
      await expect(h3(page, 'Find your way around')).toBeVisible();
    });

    test('a chevron opens another section without navigating', async ({ page }) => {
      await openDocs(page, '&section=getting-started&sub=launch');
      await expect(toggle(page, 'Tracking')).toHaveAttribute('aria-expanded', 'false');
      const before = page.url();
      await toggle(page, 'Tracking').click();
      await expect(toggle(page, 'Tracking')).toHaveAttribute('aria-expanded', 'true');
      await expect(toc(page).getByRole('list', { name: 'Tracking subsections' }).getByRole('link')).toHaveText(['Change a status', 'Follow-ups and replies', 'Safety of the data']);
      await expect(toc(page).getByRole('list', { name: 'Getting started subsections' })).toBeVisible();
      expect(page.url()).toBe(before);
      await expect(h2(page, 'Getting started')).toBeVisible();
    });

    test('j from the last subsection of a section opens the next section and closes the first', async ({ page }) => {
      await openDocs(page, '&section=getting-started&sub=appearance');
      await expect(toc(page).getByRole('link', { name: 'Appearance' })).toHaveAttribute('aria-current', 'true');
      await page.keyboard.press('j');
      await expect(page).toHaveURL(/section=tracking/);
      await expect(toc(page).getByRole('list', { name: 'Tracking subsections' })).toBeVisible();
      await expect(toc(page).getByRole('list', { name: 'Getting started subsections' })).toHaveCount(0);
      await expect(toggle(page, 'Getting started')).toHaveAttribute('aria-expanded', 'false');
    });

    test('the single-subsection sections of a version 1 guide have no chevron', async ({ page }) => {
      await page.goto(`${LEGACY}&section=today`);
      await expect(h2(page, 'Today')).toBeVisible();
      await expect(toc(page).getByRole('button')).toHaveCount(0);
    });

    for (const colorScheme of ['dark', 'light'] as const) {
      test(`at 1440x900 in ${colorScheme}: one-line rows, no sideways overflow, no serious axe issue, and a deep link opens and marks its row`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.emulateMedia({ colorScheme });
        await openDocs(page, '&section=tracking&sub=follow-ups');
        const row = toc(page).getByRole('link', { name: 'Follow-ups and replies' });
        await expect(row).toHaveAttribute('aria-current', 'true');
        await expect(row).toHaveAttribute('data-toc-active', 'true');
        await expect(toggle(page, 'Tracking')).toHaveAttribute('aria-expanded', 'true');
        await toggle(page, 'Getting started').click();
        await waitForAnimations(page);
        const heights = await rowHeights(page);
        expect(heights.filter(([kind]) => kind === 'sub')).toHaveLength(7);
        for (const [kind, px] of heights) expect(px, kind).toBe(kind === 'sub' ? 32 : 38);
        const overflow = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.guide__side, .guide-toc')].map((el) => el.scrollWidth - el.clientWidth));
        expect(overflow).toEqual([0, 0]);
        await axeClean(page);
      });
    }
  });

  test.describe('deep links', () => {
    test('?section=&sub= lands on that subsection and marks it in the contents', async ({ page }) => {
      await openDocs(page, '&section=tracking&sub=follow-ups');
      await expect(h2(page, 'Tracking')).toBeAttached();
      // The end of a short section cannot scroll its last headings to the top, so "in view" is the claim.
      await expect(h3(page, 'Follow-ups and replies')).toBeInViewport();
      expect(await scrollTop(page)).toBeGreaterThan(0);
      await expect(toc(page).getByRole('link', { name: 'Follow-ups and replies' })).toHaveAttribute('aria-current', 'true');
    });

    test('the same subsection id in two sections is told apart by the section', async ({ page }) => {
      await openDocs(page, '&section=tracking&sub=safety');
      await expect(h3(page, 'Safety of the data')).toBeInViewport();
      await expect(h3(page, 'Safety model')).toHaveCount(0);
    });

    test('a link that names only a section lands at the top of it, as every legacy link does', async ({ page }) => {
      await openDocs(page, '&section=tracking');
      await expect(h2(page, 'Tracking')).toBeVisible();
      expect(await scrollTop(page)).toBe(0);
    });

    test('an unknown section or subsection falls back instead of failing', async ({ page }) => {
      await openDocs(page, '&section=no-such-section');
      await expect(h2(page, 'Getting started')).toBeVisible();
      await page.goto(`${DOCS}&section=tracking&sub=no-such-sub`);
      await expect(h2(page, 'Tracking')).toBeVisible();
      await page.goto(`${DOCS}&sub=sessions`);
      await expect(h2(page, 'Automation')).toBeVisible();
      await expect(page.getByText('A session streams its output as it runs.')).toBeVisible();
    });

    test('a version 1 link (section only) still lands on its section', async ({ page }) => {
      await page.goto(`${LEGACY}&section=tracker`);
      await expect(h2(page, 'Tracker')).toBeVisible();
      await expect(toc(page).getByRole('link', { name: /^Tracker/ })).toHaveAttribute('aria-current', 'true');
      await page.goto(`${LEGACY}&section=no-such-section`);
      await expect(h2(page, 'Today')).toBeVisible();
    });
  });

  test.describe('scroll-spy and navigation', () => {
    test('scrolling updates sub in the URL with replace, so history does not grow, and the contents follow', async ({ page }) => {
      await openDocs(page, '&section=getting-started');
      await expect(page).toHaveURL(/sub=launch/);
      const before = await historyLength(page);
      await scrollSub(page, 'appearance');
      await expect(page).toHaveURL(/sub=appearance/);
      await expect(toc(page).getByRole('link', { name: 'Appearance' })).toHaveAttribute('aria-current', 'true');
      await expect(toc(page).getByRole('link', { name: 'Launch and sign in' })).not.toHaveAttribute('aria-current', 'true');
      await scrollSub(page, 'safety');
      await expect(page).toHaveURL(/sub=safety/);
      await expect(toc(page).getByRole('link', { name: 'Safety model' })).toHaveAttribute('aria-current', 'true');
      expect(await historyLength(page)).toBe(before);
    });

    test('the spy does not scroll the page back when it writes the URL', async ({ page }) => {
      await openDocs(page, '&section=getting-started');
      await expect(page).toHaveURL(/sub=launch/);
      await scrollSub(page, 'navigate');
      await expect(page).toHaveURL(/sub=navigate/);
      const at = await scrollTop(page);
      await page.waitForTimeout(400);
      expect(Math.abs((await scrollTop(page)) - at)).toBeLessThan(2);
    });

    test('the end of the section counts as reading its last subsection even when that heading never reaches the top', async ({ page }) => {
      await openDocs(page, '&section=getting-started');
      await expect(page).toHaveURL(/sub=launch/);
      await page.evaluate(() => {
        const main = document.querySelector('.shell__main') as HTMLElement;
        main.scrollTo({ top: main.scrollHeight });
      });
      await expect(page).toHaveURL(/sub=appearance/);
    });

    test('a click in the contents pushes a history entry, scrolls there, and Back returns to the previous place', async ({ page }) => {
      await openDocs(page, '&section=getting-started');
      await expect(page).toHaveURL(/sub=launch/);
      await toc(page).getByRole('link', { name: 'Appearance' }).click();
      await expect(page).toHaveURL(/sub=appearance/);
      await expect.poll(() => atTop(h3(page, 'Appearance')), { timeout: 5000 }).toBe(true);
      await expect(toc(page).getByRole('link', { name: 'Appearance' })).toHaveAttribute('aria-current', 'true');
      await page.goBack();
      await expect(page).toHaveURL(/sub=launch/);
      await expect.poll(() => atTop(h3(page, 'Launch and sign in')), { timeout: 5000 }).toBe(true);
      await expect(toc(page).getByRole('link', { name: 'Launch and sign in' })).toHaveAttribute('aria-current', 'true');
    });

    test('a click on the subsection already shown in the contents still scrolls to it', async ({ page }) => {
      await openDocs(page, '&section=getting-started&sub=launch');
      await scrollSub(page, 'safety');
      await page.evaluate(() => (document.querySelector('.shell__main') as HTMLElement).scrollBy(0, 200));
      await toc(page).getByRole('link', { name: 'Safety model' }).click();
      await expect.poll(() => atTop(h3(page, 'Safety model')), { timeout: 5000 }).toBe(true);
    });

    test('a section link goes to the top of that section', async ({ page }) => {
      await openDocs(page, '&section=getting-started&sub=appearance');
      await expect.poll(() => scrollTop(page)).toBeGreaterThan(100);
      await toc(page).getByRole('link', { name: /^Tracking/ }).click();
      await expect(page).toHaveURL(/section=tracking/);
      await expect(h2(page, 'Tracking')).toBeVisible();
      await expect.poll(() => atTop(h2(page, 'Tracking'))).toBe(true);
    });

    test('Previous and Next section at the bottom step through the sections and stop at the ends', async ({ page }) => {
      await openDocs(page);
      const pager = page.getByRole('navigation', { name: 'Sections' });
      await expect(pager.getByRole('link', { name: /Previous section/ })).toHaveCount(0);
      await pager.getByRole('link', { name: /Next section.*Tracking/ }).click();
      await expect(h2(page, 'Tracking')).toBeVisible();
      await expect(page.getByText('Section 2 of 3')).toBeVisible();
      await pager.getByRole('link', { name: /Next section.*Automation/ }).click();
      await expect(h2(page, 'Automation')).toBeVisible();
      await expect(pager.getByRole('link', { name: /Next section/ })).toHaveCount(0);
      await pager.getByRole('link', { name: /Previous section.*Tracking/ }).click();
      await expect(h2(page, 'Tracking')).toBeVisible();
    });

    test('j and k move between subsections, across sections, and are left alone while typing', async ({ page }) => {
      await openDocs(page, '&section=getting-started&sub=safety');
      await expect(h2(page, 'Getting started')).toBeVisible();
      await page.keyboard.press('j');
      await expect(page).toHaveURL(/sub=navigate/);
      await page.keyboard.press('j');
      await expect(page).toHaveURL(/sub=appearance/);
      await page.keyboard.press('j');
      await expect(page).toHaveURL(/section=tracking/);
      await expect(page).toHaveURL(/sub=change-status/);
      await expect(h2(page, 'Tracking')).toBeVisible();
      await page.keyboard.press('k');
      await expect(page).toHaveURL(/section=getting-started/);
      await expect(page).toHaveURL(/sub=appearance/);
      await search(page).click();
      await search(page).press('j');
      await search(page).press('k');
      expect(await search(page).inputValue()).toBe('jk');
      await expect(page).toHaveURL(/sub=appearance/);
    });

    test('j at the very last subsection and k at the very first do nothing', async ({ page }) => {
      await openDocs(page, '&section=automation&sub=sessions');
      await page.keyboard.press('j');
      await expect(page).toHaveURL(/sub=sessions/);
      await page.goto(`${DOCS}&section=getting-started&sub=launch`);
      await expect(h2(page, 'Getting started')).toBeVisible();
      await page.keyboard.press('k');
      await expect(page).toHaveURL(/sub=launch/);
    });
  });

  test.describe('search', () => {
    test('"/" focuses the search box, but not while typing elsewhere', async ({ page }) => {
      await openDocs(page);
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('/');
      await expect(search(page)).toBeFocused();
      expect(await search(page).inputValue()).toBe('');
    });

    test('finds words in any text, grouped by section, with the matches marked', async ({ page }) => {
      await openDocs(page);
      await search(page).fill('safety');
      const results = page.getByRole('region', { name: /Results for safety/ });
      await expect(results).toBeVisible();
      await expect(status(page, '2 results in 2 sections')).toBeVisible();
      await expect(results.getByRole('heading', { level: 3 })).toHaveText(['Getting started', 'Tracking']);
      await expect(results.getByRole('link')).toHaveCount(2);
      await expect(results.locator('mark').first()).toHaveText(/safety/i);
      expect(await results.locator('mark').count()).toBeGreaterThanOrEqual(2);
      await expect(page.locator('.guide-doc')).toHaveCount(0);

      await search(page).fill('sidebar');
      await expect(status(page, '1 result in 1 section')).toBeVisible();
      await search(page).fill('right after');
      const caption = page.getByRole('region', { name: /Results for right after/ });
      await expect(caption.getByRole('link', { name: /Launch and sign in/ })).toBeVisible();
      await expect(caption.locator('mark')).toHaveText(['right', 'after']);
      await search(page).fill('cadence');
      await expect(page.getByRole('region', { name: /Results for cadence/ }).getByRole('link', { name: /Follow-ups and replies/ })).toBeVisible();
    });

    test('says so when nothing matches, and one character does not search yet', async ({ page }) => {
      await openDocs(page);
      await search(page).fill('zebra');
      await expect(status(page, 'No matches for "zebra"')).toBeVisible();
      await search(page).fill('a');
      await expect(page.locator('.guide-doc')).toBeVisible();
      await expect(page.locator('.guide-results')).toHaveCount(0);
    });

    test('a result opens that subsection and closes the search; Escape clears it; Enter opens the first result', async ({ page }) => {
      await openDocs(page);
      await search(page).fill('safety');
      await page.getByRole('region', { name: /Results for safety/ }).getByRole('link', { name: /Safety of the data/ }).click();
      await expect(page).toHaveURL(/section=tracking/);
      await expect(page).toHaveURL(/sub=safety/);
      expect(await search(page).inputValue()).toBe('');
      await expect(page.locator('.guide-results')).toHaveCount(0);
      await expect(h3(page, 'Safety of the data')).toBeInViewport();

      await search(page).fill('sidebar');
      await expect(page.locator('.guide-results')).toBeVisible();
      await search(page).press('Escape');
      expect(await search(page).inputValue()).toBe('');
      await expect(page.locator('.guide-doc')).toBeVisible();
      await search(page).press('Escape');
      await expect(search(page)).not.toBeFocused();

      await search(page).fill('sidebar');
      await search(page).press('Enter');
      await expect(page).toHaveURL(/section=getting-started/);
      await expect(page).toHaveURL(/sub=navigate/);
      await expect(page.locator('.guide-results')).toHaveCount(0);
    });

    test('a result for the place already shown still scrolls to it', async ({ page }) => {
      await openDocs(page, '&section=tracking&sub=safety');
      await search(page).fill('cadence');
      await page.getByRole('region', { name: /Results for cadence/ }).getByRole('link', { name: /Follow-ups/ }).click();
      await expect(page).toHaveURL(/sub=follow-ups/);
      await search(page).fill('files stay');
      await page.getByRole('region', { name: /Results for files stay/ }).getByRole('link', { name: /Safety of the data/ }).click();
      await expect(page).toHaveURL(/sub=safety/);
      await expect(h3(page, 'Safety of the data')).toBeInViewport();
    });
  });

  test.describe('reviewed', () => {
    test('marks a subsection, counts it in total and per section, remembers it across a reload and clears it with Reset', async ({ page }) => {
      await openDocs(page, '&section=getting-started&sub=launch');
      await expect(status(page, '0 of 8 reviewed')).toBeVisible();
      const progress = page.getByRole('progressbar', { name: 'Subsections reviewed' });
      await expect(progress).toHaveAttribute('aria-valuemax', '8');
      const mark = sub(page, 'Launch and sign in').getByRole('button', { name: 'Mark reviewed' });
      await expect(mark).toHaveAttribute('aria-pressed', 'false');
      await mark.click();
      await expect(mark).toHaveAttribute('aria-pressed', 'true');
      await expect(status(page, '1 of 8 reviewed')).toBeVisible();
      await expect(progress).toHaveAttribute('aria-valuenow', '1');
      await expect(toc(page).getByRole('link', { name: /^Getting started\s*, 1 of 4 reviewed/ })).toBeVisible();
      await expect(toc(page).getByRole('link', { name: /^Launch and sign in\s*, reviewed/ })).toBeVisible();
      await expect(page.getByText('1 of 4 reviewed', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.localStorage.getItem('cc.guide.v2.docs-tour'))).toBe('["getting-started/launch"]');

      await sub(page, 'Safety model').getByRole('button', { name: 'Mark reviewed' }).click();
      await page.reload();
      await expect(status(page, '2 of 8 reviewed')).toBeVisible();
      await expect(sub(page, 'Launch and sign in').getByRole('button', { name: 'Mark reviewed' })).toHaveAttribute('aria-pressed', 'true');

      await page.getByRole('button', { name: 'Reset progress' }).click();
      await expect(status(page, '0 of 8 reviewed')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Reset progress' })).toBeDisabled();
      await page.reload();
      await expect(status(page, '0 of 8 reviewed')).toBeVisible();
    });

    test('a repeated subsection id is marked in its own section only', async ({ page }) => {
      await openDocs(page, '&section=tracking&sub=safety');
      await sub(page, 'Safety of the data').getByRole('button', { name: 'Mark reviewed' }).click();
      await expect(status(page, '1 of 8 reviewed')).toBeVisible();
      await toc(page).getByRole('link', { name: /^Getting started/ }).click();
      await expect(sub(page, 'Safety model').getByRole('button', { name: 'Mark reviewed' })).toHaveAttribute('aria-pressed', 'false');
    });

    test('works when the browser blocks storage', async ({ page }) => {
      await page.addInitScript(() => {
        for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
          Storage.prototype[method] = () => {
            throw new DOMException('blocked', 'SecurityError');
          };
        }
      });
      await openDocs(page, '&section=getting-started&sub=launch');
      await sub(page, 'Launch and sign in').getByRole('button', { name: 'Mark reviewed' }).click();
      await expect(status(page, '1 of 8 reviewed')).toBeVisible();
      await toc(page).getByRole('link', { name: /^Tracking/ }).click();
      await expect(h2(page, 'Tracking')).toBeVisible();
      await page.reload();
      await expect(status(page, '0 of 8 reviewed')).toBeVisible();
    });
  });

  test.describe('the app and the video', () => {
    test('"Open this page" goes to the page inside the app, and Back returns to the guide', async ({ page }) => {
      await openDocs(page, '&section=tracking&sub=change-status');
      await sub(page, 'Change a status').getByRole('link', { name: /Open this page/ }).click();
      await expect(page).toHaveURL(/\/tracker$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Tracker' })).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(/section=tracking/);
      await expect(h2(page, 'Tracking')).toBeVisible();
    });

    test('a subsection without a chapter has no "Watch in video" button', async ({ page }) => {
      await openDocs(page, '&section=tracking&sub=follow-ups');
      await expect(sub(page, 'Follow-ups and replies')).toBeVisible();
      await expect(sub(page, 'Follow-ups and replies').getByRole('button', { name: 'Watch in video' })).toHaveCount(0);
      await expect(sub(page, 'Change a status').getByRole('button', { name: 'Watch in video' })).toBeVisible();
    });

    test('"Watch in video" switches to the video and seeks to the start of that chapter, once', async ({ page }) => {
      await openDocs(page, '&section=tracking&sub=change-status');
      await sub(page, 'Change a status').getByRole('button', { name: 'Watch in video' }).click();
      await expect(page).not.toHaveURL(/view=/);
      await expect(page.locator('video')).toBeVisible();
      await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(0.5, 1);
      await expect(page.getByRole('button', { name: /Middle/ })).toHaveAttribute('aria-current', 'true');
      expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
      await page.getByRole('tab', { name: 'Quick guide' }).click();
      await page.getByRole('tab', { name: 'Video' }).click();
      await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(0);
    });

    test('the seek does not carry over to another tutorial and is used once when coming back', async ({ page }) => {
      await openDocs(page, '&section=tracking&sub=change-status');
      await sub(page, 'Change a status').getByRole('button', { name: 'Watch in video' }).click();
      await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(0.5, 1);
      const list = page.getByRole('navigation', { name: 'Tutorials' });
      await list.getByRole('link', { name: /Second tour/ }).click();
      await expect(page).toHaveURL(/t=second-tour/);
      await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
      await page.waitForTimeout(300);
      expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(0);
      await list.getByRole('link', { name: /Docs tour/ }).click();
      await expect(page).toHaveURL(/t=docs-tour/);
      await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
      await page.waitForTimeout(300);
      expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(0);
    });

    test('in the light theme the seek lands in the light recording', async ({ browser }) => {
      const ctx = await browser.newContext({ colorScheme: 'light' });
      const page = await ctx.newPage();
      await login(page);
      await page.goto(`${LEGACY}&section=tracker`);
      await page.getByRole('button', { name: 'Watch in video' }).click();
      await expect(page.locator('video')).toBeVisible();
      await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(0.5, 1);
      expect(await page.locator('video').evaluate((v: HTMLVideoElement) => new URL(v.currentSrc || v.src).pathname)).toBe('/api/tutorials/demo-tour/media/demo-tour-light.mp4');
      await ctx.close();
    });

    test('a tutorial warning shows in the Video view and in the guide', async ({ page }) => {
      const warning = page.getByText(/transcript file "missing\.md" not found/);
      await page.goto('/tutorials?t=warn-tour');
      await expect(page.locator('video')).toBeVisible();
      await expect(warning).toBeVisible();
      await page.getByRole('tab', { name: 'Quick guide' }).click();
      await expect(h2(page, 'Today')).toBeVisible();
      await expect(warning).toBeVisible();
    });
  });

  test.describe('figures', () => {
    test('an image follows the theme and cross-fades to the other file, leaving one layer', async ({ page }) => {
      await openDocs(page, '&section=getting-started&sub=launch');
      const fig = figure(page, 'Today, right after sign in.');
      const top = fig.locator('.doc-media__img--top');
      await expect(top).toHaveAttribute('src', '/api/tutorials/docs-tour/media/launch.dark.png');
      await expect.poll(() => top.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(320);
      await page.emulateMedia({ colorScheme: 'light' });
      await expect(top).toHaveAttribute('src', '/api/tutorials/docs-tour/media/launch.light.png');
      await expect(fig.locator('.doc-media__img')).toHaveCount(1);
      await expect.poll(() => top.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(320);
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect(top).toHaveAttribute('src', '/api/tutorials/docs-tour/media/launch.dark.png');
    });

    test('the frame has its final size before the image arrives, so nothing moves when it loads', async ({ page }) => {
      await page.route('**/launch.dark.png', async (route) => {
        await new Promise((r) => setTimeout(r, 900));
        await route.continue();
      });
      await openDocs(page, '&section=getting-started&sub=launch');
      const frame = frameOf(figure(page, 'Today, right after sign in.'));
      await expect(frame).toHaveAttribute('data-ready', 'false');
      const heading = h3(page, 'Launch and sign in');
      const place = async () => {
        const f = (await frame.boundingBox())!;
        const h = (await heading.boundingBox())!;
        return { width: f.width, height: f.height, belowHeading: Math.round(f.y - h.y) };
      };
      // Text re-wraps when the web font arrives and the content rises into place as it enters; neither is the image, so measure once both are done.
      await page.evaluate(() => document.fonts.ready);
      await waitForAnimations(page);
      const before = await place();
      const heightBefore = await page.evaluate(() => (document.querySelector('.shell__main') as HTMLElement).scrollHeight);
      expect(before.width).toBeCloseTo(320, 0);
      expect(before.height).toBeCloseTo(180, 0);
      await expect(frame).toHaveAttribute('data-ready', 'true');
      expect(await place()).toEqual(before);
      expect(await page.evaluate(() => (document.querySelector('.shell__main') as HTMLElement).scrollHeight)).toBe(heightBefore);
    });

    test('images are lazy: one far down the page is not requested until it nears the viewport', async ({ page }) => {
      const requested: string[] = [];
      page.on('request', (r) => requested.push(new URL(r.url()).pathname));
      await pushSubDown(page, 'navigate');
      await openDocs(page, '&section=getting-started');
      expect(await belowViewport(figure(page, 'The sidebar.'))).toBeGreaterThan(LAZY_LOAD_MAX_DISTANCE);
      await expect(figure(page, 'Today, right after sign in.').locator('.doc-media__img--top')).toHaveAttribute('loading', 'lazy');
      await expect.poll(() => requested.some((p) => p.endsWith('launch.dark.png'))).toBe(true);
      await page.waitForTimeout(400);
      expect(requested.some((p) => p.endsWith('navigate.dark.png'))).toBe(false);
      await scrollSub(page, 'navigate');
      await page.evaluate(() => (document.querySelector('.shell__main') as HTMLElement).scrollBy(0, 300));
      await expect.poll(() => requested.some((p) => p.endsWith('navigate.dark.png'))).toBe(true);
    });

    test('a theme change does not fetch images that are far off screen; they load in the new theme when they near the viewport', async ({ page }) => {
      const requested: string[] = [];
      page.on('request', (r) => requested.push(new URL(r.url()).pathname));
      await pushSubDown(page, 'navigate');
      await openDocs(page, '&section=getting-started');
      expect(await belowViewport(figure(page, 'The sidebar.'))).toBeGreaterThan(LAZY_LOAD_MAX_DISTANCE);
      await expect.poll(() => requested.some((p) => p.endsWith('launch.dark.png'))).toBe(true);
      const nav = figure(page, 'The sidebar.').locator('.doc-media__img--top');
      await page.emulateMedia({ colorScheme: 'light' });
      await expect(figure(page, 'Today, right after sign in.').locator('.doc-media__img--top')).toHaveAttribute('src', /launch\.light\.png/);
      await expect(nav).toHaveAttribute('src', /navigate\.light\.png/);
      await page.waitForTimeout(500);
      expect(requested.filter((p) => p.includes('navigate.'))).toEqual([]);
      await scrollSub(page, 'navigate');
      await page.evaluate(() => (document.querySelector('.shell__main') as HTMLElement).scrollBy(0, 300));
      await expect.poll(() => requested.filter((p) => p.includes('navigate.'))).toEqual(['/api/tutorials/docs-tour/media/navigate.light.png']);
    });

    test('a clip shows its poster until half of it is on screen, then plays; a click pauses it on the poster and plays it again', async ({ page }) => {
      await openDocs(page, '&section=tracking&sub=change-status');
      const fig = figure(page, 'Changing a status.');
      const top = fig.locator('.doc-media__img--top');
      await expect(frameOf(fig)).toBeVisible();
      await scrollSub(page, 'change-status');
      await expect(top).toHaveAttribute('src', '/api/tutorials/docs-tour/media/status.dark.gif');
      await expect(frameOf(fig)).toHaveAttribute('data-playing', 'true');
      await fig.getByRole('button', { name: /^Pause animation/ }).click();
      await expect(top).toHaveAttribute('src', '/api/tutorials/docs-tour/media/status.dark.png');
      await expect(frameOf(fig)).toHaveAttribute('data-playing', 'false');
      await expect(fig.locator('.doc-media__state')).toBeVisible();
      await fig.getByRole('button', { name: /^Play animation/ }).click();
      await expect(top).toHaveAttribute('src', '/api/tutorials/docs-tour/media/status.dark.gif');
    });

    test('a clip that is off screen stays on its poster', async ({ page }) => {
      await openDocs(page, '&section=getting-started');
      await page.goto(`${DOCS}&section=tracking&sub=safety`);
      await expect(h3(page, 'Safety of the data')).toBeVisible();
      await expect(h3(page, 'Safety of the data')).toBeInViewport();
      const fig = figure(page, 'Changing a status.');
      await expect(fig.locator('.doc-media__img--top')).toHaveAttribute('src', '/api/tutorials/docs-tour/media/status.dark.png');
      await expect(frameOf(fig)).toHaveAttribute('data-playing', 'false');
    });

    test('a clip follows the theme too', async ({ page }) => {
      await openDocs(page, '&section=tracking&sub=change-status');
      const fig = figure(page, 'Changing a status.');
      await scrollSub(page, 'change-status');
      await expect(fig.locator('.doc-media__img--top')).toHaveAttribute('src', '/api/tutorials/docs-tour/media/status.dark.gif');
      await page.emulateMedia({ colorScheme: 'light' });
      await expect(fig.locator('.doc-media__img--top')).toHaveAttribute('src', '/api/tutorials/docs-tour/media/status.light.gif');
    });

    test('a theme change does not move the page', async ({ page }) => {
      await openDocs(page, '&section=getting-started&sub=safety');
      await expect.poll(() => scrollTop(page)).toBeGreaterThan(100);
      const before = await scrollTop(page);
      await page.emulateMedia({ colorScheme: 'light' });
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
      await waitForAnimations(page);
      expect(Math.abs((await scrollTop(page)) - before)).toBeLessThan(2);
    });

    test.describe('the lightbox', () => {
      test('opens a larger image in a dialog, keeps focus inside, closes with Escape and gives focus back', async ({ page }) => {
        await openDocs(page, '&section=getting-started&sub=launch');
        const open = page.getByRole('button', { name: 'View larger: The Today page after signing in.' });
        await open.first().focus();
        await open.first().click();
        const dialog = page.getByRole('dialog', { name: 'The Today page after signing in.' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('img', { name: 'The Today page after signing in.' })).toHaveAttribute('src', '/api/tutorials/docs-tour/media/launch.dark.png');
        await expect(dialog.getByText('Today, right after sign in.')).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Tab');
        expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(open.first()).toBeFocused();
      });

      test('closes with its button and by clicking outside, and shows the theme the page has', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await openDocs(page, '&section=getting-started&sub=launch');
        const open = page.getByRole('button', { name: 'View larger: The Today page after signing in.' }).first();
        await open.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByRole('img')).toHaveAttribute('src', '/api/tutorials/docs-tour/media/launch.light.png');
        await dialog.getByRole('button', { name: 'Close' }).click();
        await expect(dialog).toHaveCount(0);
        await open.click();
        await expect(dialog).toBeVisible();
        // Radix starts listening for outside clicks a tick after it opens; the enter animation is longer than that.
        await waitForAnimations(page);
        await page.mouse.click(4, 4);
        await expect(dialog).toHaveCount(0);
      });

      test('is a modal like the other overlays: the shortcuts behind it do nothing', async ({ page }) => {
        await openDocs(page, '&section=getting-started&sub=launch');
        await page.getByRole('button', { name: 'View larger: The Today page after signing in.' }).first().click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.keyboard.press('Control+k');
        await expect(page.locator('.palette')).toHaveCount(0);
        await page.keyboard.press('j');
        await expect(page).toHaveURL(/sub=launch/);
        await page.keyboard.press('Escape');
      });

      test('a clip opens in the lightbox from its own button', async ({ page }) => {
        await openDocs(page, '&section=tracking&sub=change-status');
        await figure(page, 'Changing a status.').getByRole('button', { name: /^View larger/ }).click({ force: true });
        await expect(page.getByRole('dialog', { name: 'A status being changed.' })).toBeVisible();
        await page.keyboard.press('Escape');
      });
    });

    test.describe('with reduced motion', () => {
      test.use({ reducedMotion: 'reduce' });

      test('a clip starts on its poster behind a play button and plays only when asked', async ({ page }) => {
        await openDocs(page, '&section=tracking&sub=change-status');
        const fig = figure(page, 'Changing a status.');
        await scrollSub(page, 'change-status');
        await page.waitForTimeout(300);
        await expect(fig.locator('.doc-media__img--top')).toHaveAttribute('src', '/api/tutorials/docs-tour/media/status.dark.png');
        await expect(frameOf(fig)).toHaveAttribute('data-playing', 'false');
        await expect(fig.locator('.doc-media__state')).toBeVisible();
        await fig.getByRole('button', { name: /^Play animation/ }).click();
        await expect(fig.locator('.doc-media__img--top')).toHaveAttribute('src', '/api/tutorials/docs-tour/media/status.dark.gif');
      });

      test('the old layer is dropped even though no animation runs', async ({ page }) => {
        await openDocs(page, '&section=getting-started&sub=launch');
        const fig = figure(page, 'Today, right after sign in.');
        await expect.poll(() => fig.locator('.doc-media__img--top').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(320);
        await page.emulateMedia({ colorScheme: 'light' });
        await expect(fig.locator('.doc-media__img--top')).toHaveAttribute('src', /launch\.light\.png/);
        await expect(fig.locator('.doc-media__img')).toHaveCount(1);
      });
    });
  });

  test.describe('a version 1 guide, adapted', () => {
    test('is read as one subsection per section, with its steps, tip and clip', async ({ page }) => {
      await page.goto(`${LEGACY}&section=today`);
      await expect(h2(page, 'Today')).toBeVisible();
      await expect(toc(page).getByRole('link', { name: /^(Today|Tracker|Follow-ups)/ })).toHaveCount(3);
      await expect(page.getByText('The daily shortlist, ranked, with the one next action.').first()).toBeVisible();
      await expect(page.getByRole('list', { name: 'Steps' }).getByRole('listitem')).toHaveText(['Open Today to see the ranked shortlist.', 'Pick a row to open its report.']);
      await expect(page.getByLabel('Tip', { exact: true })).toContainText('Rows refresh whenever the scan finishes.');
      await expect(page.locator('figure.doc-media')).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Watch in video' })).toBeVisible();
    });

    test('plays its clip and pauses it on the poster, or on the frame it showed when it has none', async ({ page }) => {
      await page.goto(`${LEGACY}&section=today`);
      const top = page.locator('.doc-media__img--top');
      await page.locator('.doc-media__frame').scrollIntoViewIfNeeded();
      await expect(top).toHaveAttribute('src', '/api/tutorials/demo-tour/media/today.gif');
      await page.getByRole('button', { name: /^Pause animation/ }).click();
      await expect(top).toHaveAttribute('src', '/api/tutorials/demo-tour/media/poster.jpg');
      await page.getByRole('button', { name: /^Play animation/ }).click();
      await expect(top).toHaveAttribute('src', '/api/tutorials/demo-tour/media/today.gif');

      await page.goto(`${LEGACY}&section=tracker`);
      await page.locator('.doc-media__frame').scrollIntoViewIfNeeded();
      await expect.poll(() => page.locator('.doc-media__img--top').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
      await page.getByRole('button', { name: /^Pause animation/ }).click();
      await expect(page.locator('.doc-media__img--top')).toHaveAttribute('src', /^data:image\//);
      await expect.poll(() => page.locator('.doc-media__img--top').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
      await page.getByRole('button', { name: /^Play animation/ }).click();
      await expect(page.locator('.doc-media__img--top')).toHaveAttribute('src', '/api/tutorials/demo-tour/media/tracker.gif');
    });

    test.describe('with reduced motion', () => {
      test.use({ reducedMotion: 'reduce' });
      test('a clip without a poster starts on its first frame', async ({ page }) => {
        await page.goto(`${LEGACY}&section=tracker`);
        await expect(page.locator('.doc-media__img--top')).toHaveAttribute('src', /^data:image\//);
        await expect(page.getByRole('button', { name: /^Play animation/ })).toBeVisible();
      });
    });
  });

  test('has no horizontal overflow at desktop width', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDocs(page, '&section=getting-started');
    const spill = await page.evaluate(() => {
      const out: string[] = [];
      if (document.documentElement.scrollWidth > window.innerWidth) out.push('document');
      const root = document.querySelector('.guide') as HTMLElement;
      const box = root.getBoundingClientRect();
      for (const el of root.querySelectorAll('*')) {
        if (el.classList.contains('sr-only')) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > box.right + 1) out.push(`${el.tagName} ${el.className}`);
      }
      return out;
    });
    expect(spill).toEqual([]);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    const fits = (page: Page) =>
      page.evaluate(() => {
        const main = document.querySelector('.shell__main') as HTMLElement;
        const guide = document.querySelector('.guide') as HTMLElement;
        const box = guide.getBoundingClientRect();
        const out: string[] = [];
        for (const el of guide.querySelectorAll('*')) {
          if (el.classList.contains('sr-only') || el.closest('.guide-bar')) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1)) out.push(`<${el.tagName.toLowerCase()} class="${el.className}"> spills by ${Math.round(Math.max(r.right - box.right, box.left - r.left))}px`);
        }
        return { mainOverflow: main.scrollWidth - main.clientWidth, docOverflow: document.documentElement.scrollWidth - window.innerWidth, spill: out };
      });

    test('swaps the sidebar contents for a sticky Contents select and adds no horizontal scroll', async ({ page }) => {
      await openDocs(page, '&section=getting-started');
      await expect(toc(page)).toBeHidden();
      const select = page.getByRole('combobox', { name: 'Contents' });
      await expect(select).toBeVisible();
      expect(await fits(page)).toEqual({ mainOverflow: 0, docOverflow: 0, spill: [] });
      await select.selectOption({ label: 'Appearance' });
      await expect(page).toHaveURL(/sub=appearance/);
      await expect.poll(() => atTop(h3(page, 'Appearance')), { timeout: 5000 }).toBe(true);
      // Still at the top of the screen after the page scrolled.
      expect((await select.boundingBox())!.y - (await page.locator('.shell__main').boundingBox())!.y).toBeLessThan(24);
      await select.selectOption({ label: 'Change a status' });
      await expect(page).toHaveURL(/section=tracking/);
      await expect(h2(page, 'Tracking')).toBeVisible();
      expect(await fits(page)).toEqual({ mainOverflow: 0, docOverflow: 0, spill: [] });
    });

    test('lists the sections as groups and shows reviewed subsections as such', async ({ page }) => {
      await openDocs(page, '&section=getting-started&sub=launch');
      await sub(page, 'Launch and sign in').getByRole('button', { name: 'Mark reviewed' }).click();
      const select = page.getByRole('combobox', { name: 'Contents' });
      expect(await select.locator('optgroup').evaluateAll((els) => els.map((e) => e.getAttribute('label')))).toEqual(['Getting started', 'Tracking', 'Automation']);
      await expect(select.locator('option', { hasText: 'Launch and sign in' })).toHaveText(/reviewed/);
    });

    test('searches from the page, and the results fit', async ({ page }) => {
      await openDocs(page, '&section=getting-started');
      await search(page).fill('safety');
      await expect(page.locator('.guide-results')).toBeVisible();
      expect(await fits(page)).toEqual({ mainOverflow: 0, docOverflow: 0, spill: [] });
    });

    test('opens the lightbox within the screen', async ({ page }) => {
      await openDocs(page, '&section=getting-started&sub=launch');
      await page.getByRole('button', { name: 'View larger: The Today page after signing in.' }).first().click();
      const box = (await page.getByRole('dialog').boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
    });
  });

  for (const scheme of ['dark', 'light'] as const) {
    test.describe(`accessibility in the ${scheme} theme`, () => {
      test.use({ colorScheme: scheme });

      test('the guide, with a clip playing and a subsection marked', async ({ page }) => {
        await openDocs(page, '&section=tracking&sub=change-status');
        await scrollSub(page, 'change-status');
        await sub(page, 'Change a status').getByRole('button', { name: 'Mark reviewed' }).click();
        await axeClean(page);
        await page.goto(`${DOCS}&section=getting-started`);
        await expect(h2(page, 'Getting started')).toBeVisible();
        await axeClean(page);
      });

      test('the search results', async ({ page }) => {
        await openDocs(page);
        await search(page).fill('safety');
        await expect(page.locator('.guide-results')).toBeVisible();
        await axeClean(page);
      });

      test('the lightbox', async ({ page }) => {
        await openDocs(page, '&section=getting-started&sub=launch');
        await page.getByRole('button', { name: 'View larger: The Today page after signing in.' }).first().click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await axeClean(page);
      });

      test('the phone layout', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await openDocs(page, '&section=getting-started');
        await expect(page.getByRole('combobox', { name: 'Contents' })).toBeVisible();
        await axeClean(page);
      });
    });
  }
});

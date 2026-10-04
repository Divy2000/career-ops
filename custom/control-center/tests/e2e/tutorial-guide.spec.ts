/// <reference lib="dom" />
import { test, expect, type Page } from '@playwright/test';
import { axeBuilder } from './helpers.js';
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

const GUIDE_URL = '/tutorials?t=demo-tour&view=guide';
const sectionList = (page: Page) => page.getByRole('navigation', { name: 'Guide sections' });
const heading = (page: Page, name: string) => page.getByRole('heading', { level: 2, name, exact: true });
const media = (page: Page) => page.locator('.guide__media img');
const reviewedText = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });

async function openGuide(page: Page, section?: string) {
  await page.goto(section ? `${GUIDE_URL}&section=${section}` : GUIDE_URL);
  await expect(page.getByRole('heading', { level: 1, name: 'Tutorials' })).toBeVisible();
  await expect(sectionList(page).getByRole('button')).toHaveCount(3);
}

test.describe('Tutorials quick guide', () => {
  test.beforeEach(async ({ page }) => login(page));

  test('a tutorial with a guide has a Video / Quick guide toggle that is kept in the URL, and one without has none', async ({ page }) => {
    await page.goto('/tutorials');
    const tabs = page.getByRole('tablist', { name: 'Tutorial view' });
    await expect(tabs.getByRole('tab', { name: 'Video' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('video')).toBeVisible();
    await tabs.getByRole('tab', { name: 'Quick guide' }).click();
    await expect(page).toHaveURL(/view=guide/);
    await expect(tabs.getByRole('tab', { name: 'Quick guide' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('video')).toHaveCount(0);
    await expect(heading(page, 'Today')).toBeVisible();
    await tabs.getByRole('tab', { name: 'Video' }).click();
    await expect(page).not.toHaveURL(/view=/);
    await expect(page.locator('video')).toBeVisible();

    await page.goto('/tutorials?t=second-tour');
    await expect(page.getByRole('heading', { level: 2, name: 'Second tour' })).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Tutorial view' })).toHaveCount(0);
    await page.goto('/tutorials?t=second-tour&view=guide');
    await expect(page.locator('video')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Guide sections' })).toHaveCount(0);
  });

  test('the view and the section are shareable links and back and forward follow them', async ({ page }) => {
    await openGuide(page, 'tracker');
    await expect(heading(page, 'Tracker')).toBeVisible();
    await expect(sectionList(page).getByRole('button', { name: /^Tracker/ })).toHaveAttribute('aria-current', 'true');
    await sectionList(page).getByRole('button', { name: /^Follow-ups/ }).click();
    await expect(page).toHaveURL(/section=followups/);
    await expect(heading(page, 'Follow-ups')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/section=tracker/);
    await expect(heading(page, 'Tracker')).toBeVisible();
    await page.goForward();
    await expect(heading(page, 'Follow-ups')).toBeVisible();
    await page.goto(`${GUIDE_URL}&section=no-such-section`);
    await expect(heading(page, 'Today')).toBeVisible();
  });

  test('switching tutorial drops the guide view', async ({ page }) => {
    await openGuide(page, 'tracker');
    await page.getByRole('navigation', { name: 'Tutorials' }).getByRole('link', { name: /Second tour/ }).click();
    await expect(page).toHaveURL(/t=second-tour/);
    await expect(page).not.toHaveURL(/view=/);
  });

  test('shows the selected section with its gif, numbered steps, tips and the section list', async ({ page }) => {
    await openGuide(page, 'today');
    await expect(page.getByText('The daily shortlist, ranked, with the one next action.')).toBeVisible();
    await expect(page.locator('.guide__steps li')).toHaveText(['Open Today to see the ranked shortlist.', 'Pick a row to open its report.']);
    await expect(page.getByRole('heading', { level: 3, name: 'Tips' })).toBeVisible();
    await expect(page.getByText('Rows refresh whenever the scan finishes.')).toBeVisible();
    await expect(media(page)).toHaveAttribute('src', '/api/tutorials/demo-tour/media/today.gif');
    await expect(media(page)).toHaveAttribute('loading', 'lazy');
    await expect.poll(() => media(page).evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    await sectionList(page).getByRole('button', { name: /^Follow-ups/ }).click();
    await expect(page.locator('.guide__steps li')).toHaveCount(1);
    await expect(page.getByText('Cadence comes from your profile.')).toBeVisible();
    await sectionList(page).getByRole('button', { name: /^Tracker/ }).click();
    await expect(page.getByRole('heading', { level: 3, name: 'Tips' })).toHaveCount(0);
  });

  test('the search box filters the sections by title, summary and steps', async ({ page }) => {
    await openGuide(page);
    const search = page.getByRole('searchbox', { name: 'Search the guide' });
    const names = () => sectionList(page).getByRole('button').allInnerTexts();
    await search.fill('track');
    await expect.poll(async () => (await names()).map((n) => n.trim())).toEqual(['Tracker']);
    await search.fill('nudge');
    await expect.poll(async () => (await names()).map((n) => n.trim())).toEqual(['Follow-ups']);
    await search.fill('ranked shortlist');
    await expect.poll(async () => (await names()).map((n) => n.trim())).toEqual(['Today']);
    await search.fill('zebra');
    await expect(sectionList(page).getByRole('button')).toHaveCount(0);
    await expect(page.getByText('No sections match "zebra".')).toBeVisible();
    await search.fill('');
    await expect(sectionList(page).getByRole('button')).toHaveCount(3);
    await search.fill('row');
    await expect(sectionList(page).getByRole('button')).toHaveCount(2);
  });

  test('mark reviewed is remembered across a reload, counted in the progress bar and cleared by reset', async ({ page }) => {
    await openGuide(page, 'today');
    const progress = page.getByRole('progressbar', { name: 'Sections reviewed' });
    await expect(reviewedText(page, '0 of 3 reviewed')).toBeVisible();
    await expect(progress).toHaveAttribute('aria-valuenow', '0');
    await expect(progress).toHaveAttribute('aria-valuemax', '3');
    const mark = page.getByRole('button', { name: 'Mark reviewed' });
    await expect(mark).toHaveAttribute('aria-pressed', 'false');
    await mark.click();
    await expect(mark).toHaveAttribute('aria-pressed', 'true');
    await expect(reviewedText(page, '1 of 3 reviewed')).toBeVisible();
    await expect(sectionList(page).getByRole('button', { name: /^Today.*reviewed/ })).toBeVisible();
    await sectionList(page).getByRole('button', { name: /^Tracker/ }).click();
    await expect(page.getByRole('button', { name: 'Mark reviewed' })).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Mark reviewed' }).click();
    await expect(reviewedText(page, '2 of 3 reviewed')).toBeVisible();

    await page.reload();
    await expect(reviewedText(page, '2 of 3 reviewed')).toBeVisible();
    await expect(progress).toHaveAttribute('aria-valuenow', '2');
    await expect(sectionList(page).getByRole('button', { name: /^Today.*reviewed/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark reviewed' })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'Mark reviewed' }).click();
    await expect(reviewedText(page, '1 of 3 reviewed')).toBeVisible();
    await page.getByRole('button', { name: 'Reset progress' }).click();
    await expect(reviewedText(page, '0 of 3 reviewed')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reset progress' })).toBeDisabled();
    await page.reload();
    await expect(reviewedText(page, '0 of 3 reviewed')).toBeVisible();
  });

  test('the guide works when the browser blocks storage', async ({ page }) => {
    await page.addInitScript(() => {
      for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
        Storage.prototype[method] = () => {
          throw new DOMException('blocked', 'SecurityError');
        };
      }
    });
    await openGuide(page, 'today');
    await page.getByRole('button', { name: 'Mark reviewed' }).click();
    await expect(reviewedText(page, '1 of 3 reviewed')).toBeVisible();
    await sectionList(page).getByRole('button', { name: /^Tracker/ }).click();
    await expect(heading(page, 'Tracker')).toBeVisible();
    await page.reload();
    await expect(reviewedText(page, '0 of 3 reviewed')).toBeVisible();
  });

  test('"Watch this part" switches to the video and seeks to the start of that chapter', async ({ page }) => {
    await openGuide(page, 'tracker');
    await page.getByRole('button', { name: 'Watch this part' }).click();
    await expect(page).not.toHaveURL(/view=/);
    await expect(page.locator('video')).toBeVisible();
    await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(0.5, 1);
    await expect(page.getByRole('button', { name: /Middle/ })).toHaveAttribute('aria-current', 'true');
    expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    await page.getByRole('tab', { name: 'Quick guide' }).click();
    await page.getByRole('tab', { name: 'Video' }).click();
    await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(0);
  });

  test('the chapter "Watch this part" seeks to does not carry over to another tutorial', async ({ page }) => {
    await openGuide(page, 'tracker');
    await page.getByRole('button', { name: 'Watch this part' }).click();
    await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(0.5, 1);
    await page.getByRole('navigation', { name: 'Tutorials' }).getByRole('link', { name: /Second tour/ }).click();
    await expect(page).toHaveURL(/t=second-tour/);
    await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(300);
    expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(0);
  });

  test('the chapter "Watch this part" seeked to is used once: returning to that tutorial starts at 0', async ({ page }) => {
    await openGuide(page, 'tracker');
    await page.getByRole('button', { name: 'Watch this part' }).click();
    await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(0.5, 1);
    const list = page.getByRole('navigation', { name: 'Tutorials' });
    await list.getByRole('link', { name: /Second tour/ }).click();
    await expect(page).toHaveURL(/t=second-tour/);
    await list.getByRole('link', { name: /Demo tour/ }).click();
    await expect(page).toHaveURL(/t=demo-tour/);
    await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(300);
    expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(0);
  });

  test('a tutorial warning shows in the Video view and in the Quick guide view', async ({ page }) => {
    const warning = page.getByText(/transcript file "missing\.md" not found/);
    await page.goto('/tutorials?t=warn-tour');
    await expect(page.locator('video')).toBeVisible();
    await expect(warning).toBeVisible();
    await page.getByRole('tab', { name: 'Quick guide' }).click();
    await expect(heading(page, 'Today')).toBeVisible();
    await expect(warning).toBeVisible();
    await page.goto('/tutorials?t=demo-tour&view=guide');
    await expect(heading(page, 'Today')).toBeVisible();
    await expect(page.getByText(/not found, so it is ignored/)).toHaveCount(0);
  });

  test('a section without a chapter has no "Watch this part" button', async ({ page }) => {
    await openGuide(page, 'followups');
    await expect(page.getByRole('button', { name: 'Watch this part' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Open this page' })).toBeVisible();
  });

  test('"Open this page" goes to the page inside the app', async ({ page }) => {
    await openGuide(page, 'tracker');
    await page.getByRole('link', { name: 'Open this page' }).click();
    await expect(page).toHaveURL(/\/tracker$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Tracker' })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/section=tracker/);
    await expect(heading(page, 'Tracker')).toBeVisible();
  });

  test('j, k and the arrow keys move between sections, Enter on the list selects, and typing in the search is left alone', async ({ page }) => {
    await openGuide(page);
    await page.keyboard.press('j');
    await expect(heading(page, 'Tracker')).toBeVisible();
    await expect(page).toHaveURL(/section=tracker/);
    await page.keyboard.press('ArrowDown');
    await expect(heading(page, 'Follow-ups')).toBeVisible();
    await page.keyboard.press('j');
    await expect(heading(page, 'Follow-ups')).toBeVisible();
    await page.keyboard.press('k');
    await expect(heading(page, 'Tracker')).toBeVisible();
    await page.keyboard.press('ArrowUp');
    await expect(heading(page, 'Today')).toBeVisible();
    await page.keyboard.press('k');
    await expect(heading(page, 'Today')).toBeVisible();

    const list = sectionList(page);
    await list.getByRole('button', { name: /^Follow-ups/ }).focus();
    await page.keyboard.press('Enter');
    await expect(heading(page, 'Follow-ups')).toBeVisible();
    await page.keyboard.press('k');
    await expect(heading(page, 'Tracker')).toBeVisible();
    await expect(list.getByRole('button', { name: /^Tracker/ })).toBeFocused();

    const search = page.getByRole('searchbox', { name: 'Search the guide' });
    await search.click();
    await search.press('j');
    await search.press('k');
    expect(await search.inputValue()).toBe('jk');
    await expect(heading(page, 'Tracker')).toBeVisible();
  });

  test('Previous and Next at the bottom of a section step through the list and stop at its ends', async ({ page }) => {
    await openGuide(page, 'today');
    const prev = page.getByRole('button', { name: /^Previous/ });
    const next = page.getByRole('button', { name: /^Next/ });
    await expect(prev).toBeDisabled();
    await expect(next).toHaveText(/Tracker/);
    await next.click();
    await expect(heading(page, 'Tracker')).toBeVisible();
    await expect(prev).toHaveText(/Today/);
    await next.click();
    await expect(heading(page, 'Follow-ups')).toBeVisible();
    await expect(next).toBeDisabled();
    await prev.click();
    await expect(heading(page, 'Tracker')).toBeVisible();
  });

  test('clicking the animation pauses it on the poster and plays it again', async ({ page }) => {
    await openGuide(page, 'today');
    const toggle = page.getByRole('button', { name: 'Pause animation' });
    await expect(media(page)).toHaveAttribute('src', '/api/tutorials/demo-tour/media/today.gif');
    await toggle.click();
    await expect(media(page)).toHaveAttribute('src', '/api/tutorials/demo-tour/media/poster.jpg');
    await expect(page.getByRole('button', { name: 'Play animation' })).toBeVisible();
    await expect(page.locator('.guide__play')).toBeVisible();
    await page.getByRole('button', { name: 'Play animation' }).click();
    await expect(media(page)).toHaveAttribute('src', '/api/tutorials/demo-tour/media/today.gif');
    await expect(page.locator('.guide__play')).toHaveCount(0);
  });

  test('without a poster, pausing freezes the current frame and playing resumes the gif', async ({ page }) => {
    await openGuide(page, 'tracker');
    await expect.poll(() => media(page).evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Pause animation' }).click();
    await expect(media(page)).toHaveAttribute('src', /^data:image\//);
    await expect.poll(() => media(page).evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Play animation' }).click();
    await expect(media(page)).toHaveAttribute('src', '/api/tutorials/demo-tour/media/tracker.gif');
  });

  test('with reduced motion the animation starts paused on the poster or the first frame, behind a play button', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openGuide(page, 'today');
    await expect(media(page)).toHaveAttribute('src', '/api/tutorials/demo-tour/media/poster.jpg');
    await expect(page.getByRole('button', { name: 'Play animation' })).toBeVisible();
    await page.getByRole('button', { name: 'Play animation' }).click();
    await expect(media(page)).toHaveAttribute('src', '/api/tutorials/demo-tour/media/today.gif');
    await sectionList(page).getByRole('button', { name: /^Tracker/ }).click();
    await expect(media(page)).toHaveAttribute('src', /^data:image\//);
    await expect.poll(() => media(page).evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Play animation' })).toBeVisible();
  });

  test('has no serious accessibility violations', async ({ page }) => {
    await openGuide(page, 'today');
    await axeClean(page);
    await page.getByRole('button', { name: 'Pause animation' }).click();
    await axeClean(page);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    // The app shell (top bar, sidebar) sets the page width, and its async chips make that width vary; the guide must fit the main
    // column it is given, so it adds no horizontal overflow of its own whatever the shell does.
    const fitsMain = (page: Page) =>
      page.evaluate(() => {
        const main = document.querySelector('.shell__main') as HTMLElement;
        const guide = document.querySelector('.guide') as HTMLElement;
        return { mainOverflow: main.scrollWidth - main.clientWidth, guideBeyondMain: Math.round(guide.getBoundingClientRect().right - main.getBoundingClientRect().right) };
      });
    const guideSpill = (page: Page) =>
      page.evaluate(() => {
        const root = document.querySelector('.guide') as HTMLElement;
        const box = root.getBoundingClientRect();
        const out: string[] = [];
        if (root.scrollWidth > root.clientWidth) out.push(`.guide scrollWidth ${root.scrollWidth} > ${root.clientWidth}`);
        for (const el of root.querySelectorAll('*')) {
          if (el.classList.contains('sr-only')) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1)) out.push(`<${el.tagName.toLowerCase()} class="${el.className}"> spills by ${Math.round(Math.max(r.right - box.right, box.left - r.left))}px`);
        }
        return out;
      });

    test('adds no horizontal scroll of its own, swaps the section list for a select, and stays usable', async ({ page }) => {
      await page.goto(`${GUIDE_URL}&section=today`);
      await expect(heading(page, 'Today')).toBeVisible();
      expect((await fitsMain(page)).mainOverflow).toBe(0);
      expect((await fitsMain(page)).guideBeyondMain).toBeLessThanOrEqual(0);
      expect(await guideSpill(page)).toEqual([]);
      await expect(sectionList(page)).toBeHidden();
      const select = page.getByRole('combobox', { name: 'Section' });
      await expect(select).toBeVisible();
      await select.selectOption({ label: 'Follow-ups' });
      await expect(page).toHaveURL(/section=followups/);
      await expect(heading(page, 'Follow-ups')).toBeVisible();
      await select.selectOption({ label: 'Tracker' });
      await expect(heading(page, 'Tracker')).toBeVisible();
      await page.getByRole('searchbox', { name: 'Search the guide' }).fill('nudge');
      await expect(select.locator('option')).toHaveText(['Follow-ups']);
      await expect(heading(page, 'Follow-ups')).toBeVisible();
      await page.getByRole('searchbox', { name: 'Search the guide' }).fill('');
      await select.selectOption({ label: 'Tracker' });
      await page.getByRole('button', { name: 'Mark reviewed' }).click();
      await expect(select.locator('option', { hasText: 'Tracker' })).toHaveText(/reviewed/);
      for (const name of ['Mark reviewed', 'Watch this part']) await expect(page.getByRole('button', { name })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Open this page' })).toBeVisible();
      expect((await fitsMain(page)).mainOverflow).toBe(0);
      expect((await fitsMain(page)).guideBeyondMain).toBeLessThanOrEqual(0);
      expect(await guideSpill(page)).toEqual([]);
      await axeClean(page);
    });
  });

  test('has no horizontal overflow at desktop width', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openGuide(page, 'today');
    const spill = await page.evaluate(() => {
      const out: string[] = [];
      if (document.documentElement.scrollWidth > window.innerWidth) out.push('document');
      const root = document.querySelector('.guide') as HTMLElement;
      for (const el of root.querySelectorAll('*')) {
        if (el.classList.contains('sr-only')) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > root.getBoundingClientRect().right + 1) out.push(`${el.tagName} ${el.className}`);
      }
      return out;
    });
    expect(spill).toEqual([]);
  });
});

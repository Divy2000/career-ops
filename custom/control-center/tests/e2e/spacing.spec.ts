/// <reference lib="dom" />
import { test, expect, type Page } from '@playwright/test';
import { E2E_TOKEN } from '../../playwright.config.js';
import { NAV_GROUPS } from '../../web/nav.js';
import { waitForAnimations } from './helpers.js';

const ROUTES = [
  ...NAV_GROUPS.flatMap((g) => g.items.map((i) => i.to)),
  '/pipeline?tab=shortlist',
  '/pipeline?tab=batch',
  '/tracker/1',
  '/sponsorship?tab=lookup&q=Acme%20Robotics',
  '/sponsorship?tab=feed',
  '/settings?tab=app',
  '/settings?tab=rules',
  '/settings?tab=engine',
];
const SPACE_4 = 16;

async function login(page: Page) {
  await page.goto(`/auth?t=${E2E_TOKEN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

/** Boxed blocks (cards, tables, layout wrappers) that sit directly after one another with almost no space between them. */
const touchingBlocks = (page: Page) =>
  page.evaluate(() => {
    const layout = (el: Element) => /(^| )(grid-2|split|tiles|stack|apply-grid)( |$)/.test(el.className.toString());
    const boxed = (el: Element) => {
      if (layout(el)) return true;
      const cs = getComputedStyle(el);
      return cs.borderTopStyle !== 'none' && cs.borderTopWidth !== '0px' && cs.display !== 'inline' && cs.display !== 'none';
    };
    const found: string[] = [];
    for (const el of document.querySelectorAll('.shell__main *')) {
      const next = el.nextElementSibling;
      // Rows inside one card that are separated by a rule (quick-runs groups) are not stacked cards.
      if (!next || el.matches('.quick-runs__group') || !boxed(el) || !boxed(next)) continue;
      if (getComputedStyle(el).position === 'absolute' || getComputedStyle(next).position === 'absolute') continue;
      const a = el.getBoundingClientRect();
      const b = next.getBoundingClientRect();
      if (a.width < 120 || b.width < 120 || Math.min(a.right, b.right) - Math.max(a.left, b.left) < 60) continue;
      const gap = b.top - a.bottom;
      if (gap >= 0 && gap < 8) found.push(`${el.className} -> ${next.className}: ${gap.toFixed(1)}px`);
    }
    return found;
  });

for (const [name, viewport] of [
  ['1440x900', { width: 1440, height: 900 }],
  ['390x844', { width: 390, height: 844 }],
] as const) {
  test.describe(`vertical rhythm at ${name}`, () => {
    test.use({ viewport });
    test.beforeEach(async ({ page }) => login(page));

    test('Today: the Quick evaluate card and the cards below it are one spacing step apart, like the right column', async ({ page }) => {
      await expect(page.getByRole('heading', { name: 'Shortlist top 15' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Decisions' })).toBeVisible();
      await waitForAnimations(page);
      const gaps = await page.evaluate(() => {
        const rect = (el: Element | null) => el!.getBoundingClientRect();
        const quick = [...document.querySelectorAll('.shell__main section .card')].find((c) => c.querySelector('h2')?.textContent?.startsWith('Quick evaluate'))!;
        const row = document.querySelector('.grid-2--today')!;
        const column = [...row.querySelectorAll(':scope > .stack')].map((s) => [...s.querySelectorAll(':scope > .card')]);
        const between = (cards: Element[]) => cards.slice(1).map((c, i) => rect(c).top - rect(cards[i]!).bottom);
        return { quickToRow: rect(row).top - rect(quick).bottom, columns: column.map(between) };
      });
      expect(gaps.quickToRow).toBe(SPACE_4);
      for (const c of gaps.columns) for (const g of c) expect(g).toBe(SPACE_4);
    });

    test('no page stacks boxed blocks edge to edge', async ({ page }) => {
      const touching: Record<string, string[]> = {};
      for (const url of ROUTES) {
        await page.goto(url);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.locator('.skeleton')).toHaveCount(0);
        await waitForAnimations(page);
        const found = await touchingBlocks(page);
        if (found.length) touching[url] = found;
      }
      expect(touching).toEqual({});
    });
  });
}

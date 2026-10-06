/// <reference lib="dom" />
import { test, expect } from '@playwright/test';
import { waitForAnimations } from './helpers.js';

test.describe('waitForAnimations', () => {
  test('resolves once a finite animation has finished, even when the page never paints another frame', async ({ page }) => {
    await page.setContent('<style>@keyframes fade { from { opacity: 0 } } .box { animation: fade 200ms }</style><div class="box">Box</div>');
    // A frame loop that has stalled: nothing scheduled with requestAnimationFrame ever runs.
    await page.evaluate(() => {
      window.requestAnimationFrame = () => 0;
    });
    await waitForAnimations(page, { timeout: 3000 });
  });

  test('ignores an infinite animation', async ({ page }) => {
    await page.setContent('<style>@keyframes spin { to { transform: rotate(1turn) } } .spinner { animation: spin 1s linear infinite }</style><div class="spinner">Spinner</div>');
    await waitForAnimations(page, { timeout: 3000 });
  });

  test('on timeout, names every animation still running: its target, its name and its play state', async ({ page }) => {
    await page.setContent(
      '<style>@keyframes slow-rise { from { opacity: 0 } } .card.card--warn { animation: slow-rise 60s } .row { transition: color 60s }</style><div id="hero" class="card card--warn">Card</div><a class="row" href="#">Row</a>',
    );
    await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>('.row')!;
      // Resolve the starting color first, so the change below runs as a transition.
      getComputedStyle(row).getPropertyValue('color');
      row.style.color = 'rgb(255, 0, 0)';
    });
    const error = await waitForAnimations(page, { timeout: 500 }).then(
      () => null,
      (e: Error) => e,
    );
    expect(error?.message).toContain('div#hero.card.card--warn: animation slow-rise, running');
    expect(error?.message).toContain('a.row: transition color, running');
  });
});

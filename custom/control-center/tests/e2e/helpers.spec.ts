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
});

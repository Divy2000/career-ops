/// <reference lib="dom" />
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';

/**
 * Resolves once every finite CSS animation and transition has finished. Axe samples colors, so running it
 * while a page-enter fade or a theme reveal is mid-flight can report a contrast failure that no user sees.
 * Infinite animations (the skeleton shimmer) never finish and are not waited for.
 */
export async function waitForAnimations(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.getAnimations().every((a) => {
        const timing = a.effect?.getComputedTiming();
        return timing?.iterations === Infinity || a.playState === 'finished' || a.playState === 'idle';
      }),
    undefined,
    { timeout: 10_000 },
  );
}

/** An AxeBuilder that starts from a settled page. Chain .exclude()/.include() as usual, then .analyze(). */
export async function axeBuilder(page: Page): Promise<AxeBuilder> {
  await waitForAnimations(page);
  return new AxeBuilder({ page });
}

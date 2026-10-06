/// <reference lib="dom" />
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';

/**
 * Resolves once every finite CSS animation and transition has finished. Axe samples colors, so running it
 * while a page-enter fade or a theme reveal is mid-flight can report a contrast failure that no user sees.
 * Infinite animations (the skeleton shimmer) never finish and are not waited for.
 * It polls on a timer, not on animation frames: a frame loop that stalls under load would otherwise stop the check itself.
 * On timeout the error names every animation still running, so a flake says what it waited on.
 */
export async function waitForAnimations(page: Page, { timeout = 10_000 }: { timeout?: number } = {}): Promise<void> {
  try {
    await page.waitForFunction(
      () =>
        document.getAnimations().every((a) => {
          const timing = a.effect?.getComputedTiming();
          return timing?.iterations === Infinity || a.playState === 'finished' || a.playState === 'idle';
        }),
      undefined,
      { timeout, polling: 100 },
    );
  } catch (err) {
    const running = await page
      .evaluate(() =>
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity && a.playState !== 'finished' && a.playState !== 'idle')
          .map((a) => {
            const effect = a.effect as KeyframeEffect | null;
            const el = effect?.target;
            const target = el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.classList].map((c) => `.${c}`).join('')}${effect?.pseudoElement ?? ''}` : '(no target)';
            const what = a instanceof CSSTransition ? `transition ${a.transitionProperty}` : a instanceof CSSAnimation ? `animation ${a.animationName}` : `script animation ${a.id || '(unnamed)'}`;
            return `${target}: ${what}, ${a.playState}`;
          }),
      )
      .catch((e: unknown) => [`(could not list them: ${e instanceof Error ? e.message : String(e)})`]);
    throw new Error(`${err instanceof Error ? err.message : String(err)}\nStill running:\n${running.map((r) => `  ${r}`).join('\n')}`, { cause: err });
  }
}

/** An AxeBuilder that starts from a settled page. Chain .exclude()/.include() as usual, then .analyze(). */
export async function axeBuilder(page: Page): Promise<AxeBuilder> {
  await waitForAnimations(page);
  return new AxeBuilder({ page });
}

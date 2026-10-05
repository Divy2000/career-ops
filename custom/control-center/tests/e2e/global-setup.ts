import type { FullConfig } from '@playwright/test';

/**
 * Every spec shares one data root, and some change rows later specs read (actions.spec.ts sets statuses on rows 2, 5
 * and 6), so the suite only holds with the single worker playwright.config.ts sets. A --workers flag overrides that;
 * stop before any test runs instead of failing at random.
 */
export default function globalSetup(config: FullConfig): void {
  if (config.workers !== 1) {
    throw new Error(`The e2e suite runs on 1 worker: every spec shares one data root and some depend on what earlier ones wrote. Drop --workers=${config.workers}.`);
  }
}

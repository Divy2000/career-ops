import { describe, expect, it } from 'vitest';
import type { FullConfig } from '@playwright/test';
import globalSetup from '../e2e/global-setup.js';

const withWorkers = (workers: number) => ({ workers }) as FullConfig;

describe('e2e global setup', () => {
  it('fails fast when the run has more than one worker, since every spec shares one data root', () => {
    expect(() => globalSetup(withWorkers(2))).toThrow(/1 worker.*one data root.*--workers=2/s);
    expect(() => globalSetup(withWorkers(4))).toThrow(/--workers=4/);
  });

  it('lets the configured single worker run', () => {
    expect(() => globalSetup(withWorkers(1))).not.toThrow();
  });
});

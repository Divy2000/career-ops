// The in-flight start mark must survive a page reload: the server may still be starting the paid session even though
// the page that sent the request is gone, so a reloaded page must not offer a second start beside the orphaned one
// (R17-weblib-L3-01).
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  sessionStorage.clear();
  vi.resetModules();
});

describe('lastSession start mark', () => {
  it('keeps the in-flight mark across a reload, so the button stays off until the start reports', async () => {
    const { lastSession } = await import('@web/lib/lastSession');
    lastSession('cc.test.start').setStarting(true);
    // A reload re-evaluates the module (a fresh page load) while sessionStorage is kept.
    vi.resetModules();
    const fresh = (await import('@web/lib/lastSession')).lastSession('cc.test.start');
    expect(fresh.starting()).toBe(true);
    fresh.setStarting(false);
    expect(fresh.starting()).toBe(false);
  });
});

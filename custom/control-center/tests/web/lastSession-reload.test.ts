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

describe('lastSession start mark from the future', () => {
  it('treats a mark stamped ahead of the clock as expired and clears it, so the launcher is not disabled until then (R27-weblib-X-01)', async () => {
    const { lastSession } = await import('@web/lib/lastSession');
    sessionStorage.setItem('cc.test.future:starting', String(Date.now() + 60 * 60_000));
    expect(lastSession('cc.test.future').starting()).toBe(false);
    expect(sessionStorage.getItem('cc.test.future:starting')).toBeNull();
  });

  it('clears a malformed mark', async () => {
    const { lastSession } = await import('@web/lib/lastSession');
    sessionStorage.setItem('cc.test.junk:starting', 'not-a-time');
    expect(lastSession('cc.test.junk').starting()).toBe(false);
    expect(sessionStorage.getItem('cc.test.junk:starting')).toBeNull();
  });
});

describe('lastSession start mark across a small clock step', () => {
  it('keeps a mark stamped a second ahead, so a start in flight across an NTP correction still holds the form off', async () => {
    const { lastSession } = await import('@web/lib/lastSession');
    sessionStorage.setItem('cc.test.ntp:starting', String(Date.now() + 1_000));
    expect(lastSession('cc.test.ntp').starting()).toBe(true);
  });

  it('clears an expired mark when it is read', async () => {
    const { lastSession, START_REPORT_WINDOW_MS } = await import('@web/lib/lastSession');
    sessionStorage.setItem('cc.test.old:starting', String(Date.now() - START_REPORT_WINDOW_MS - 1_000));
    expect(lastSession('cc.test.old').starting()).toBe(false);
    expect(sessionStorage.getItem('cc.test.old:starting')).toBeNull();
  });
});

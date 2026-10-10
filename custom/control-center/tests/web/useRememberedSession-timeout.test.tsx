// A start mark that survives a reload has no panel left to clear it (R17-weblib-L3-01), so a mount that stays waiting
// forever would disable the start form in that tab. The mark must be cleared after a bounded window when no session
// reports, so the button comes back (a second start is still guarded by the sessions list).
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastSession } from '@web/lib/lastSession';
import { useRememberedSession } from '@web/lib/useRememberedSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  sessionStorage.clear();
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

function Probe({ onWaiting }: { onWaiting: (w: boolean) => void }) {
  const s = useRememberedSession('cc.test.timeout');
  useEffect(() => {
    onWaiting(s.waiting);
  }, [s.waiting, onWaiting]);
  return createElement('span', null, s.waiting ? 'waiting' : 'ready');
}

describe('useRememberedSession clears a reloaded start mark that never reports', () => {
  it('brings the start form back after the bounded window instead of disabling it forever', async () => {
    lastSession('cc.test.timeout').setStarting(true);
    await act(async () => {
      root.render(createElement(Probe, { onWaiting: () => {} }));
    });
    expect(host.textContent).toBe('waiting');
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(host.textContent).toBe('ready');
    expect(lastSession('cc.test.timeout').starting()).toBe(false);
  });
});

// A start whose POST outlives the start window (R28-weblib-X-01): the mark expires, the page is left and come back to,
// and a second start is sent. When the first POST finally answers, its report must not replace the newer session the
// page holds, and its failure must not clear the newer start's mark.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastSession } from '@web/lib/lastSession';
import { useRememberedSession } from '@web/lib/useRememberedSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = 'cc.test.late-start';

let host: HTMLElement;
let root: Root;
let hook: ReturnType<typeof useRememberedSession>;
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

function Probe() {
  hook = useRememberedSession(KEY);
  return createElement('span', null, hook.panel.sessionId ?? 'none');
}

/** Starts on a first mount, leaves the page before the POST answers, comes back once the mark expired. */
async function firstStartOutlivesTheWindow() {
  await act(async () => root.render(createElement(Probe)));
  await act(async () => hook.start());
  await act(async () => hook.panel.onStarting());
  const first = hook.panel;
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  expect(hook.waiting).toBe(true);
  await act(async () => {
    vi.advanceTimersByTime(15_000);
  });
  expect(hook.busy).toBe(false);
  return first;
}

describe('useRememberedSession with a start that answers after a newer one', () => {
  it('given a newer start reported its session, when the older start reports late, then the newer session stays held', async () => {
    const first = await firstStartOutlivesTheWindow();
    await act(async () => hook.start());
    await act(async () => hook.panel.onStarting());
    await act(async () => hook.panel.onSessionId('second'));
    await act(async () => first.onSessionId('first'));
    expect(lastSession(KEY).read()).toBe('second');
    expect(hook.panel.sessionId).toBe('second');
  });

  it('given a newer start is still in flight, when the older start reports late, then the newer start keeps its mark and wins', async () => {
    const first = await firstStartOutlivesTheWindow();
    await act(async () => hook.start());
    await act(async () => hook.panel.onStarting());
    await act(async () => first.onSessionId('first'));
    expect(lastSession(KEY).read()).toBeNull();
    expect(lastSession(KEY).starting()).toBe(true);
    expect(hook.busy).toBe(true);
    await act(async () => hook.panel.onSessionId('second'));
    expect(lastSession(KEY).read()).toBe('second');
  });

  it('given a newer start is still in flight, when the older start fails late, then the newer start keeps its mark', async () => {
    const first = await firstStartOutlivesTheWindow();
    await act(async () => hook.start());
    await act(async () => hook.panel.onStarting());
    await act(async () => first.onStartFailed());
    expect(lastSession(KEY).starting()).toBe(true);
    expect(hook.busy).toBe(true);
  });

  it('given no newer start was sent, when the older start reports late, then its session is re-attached', async () => {
    const first = await firstStartOutlivesTheWindow();
    await act(async () => first.onSessionId('first'));
    expect(lastSession(KEY).read()).toBe('first');
    expect(hook.panel.sessionId).toBe('first');
  });
});

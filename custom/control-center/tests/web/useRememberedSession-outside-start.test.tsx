// A start marked through a raw lastSession (AskDrawer's generatePdf) must keep a mounted guard busy even when that guard
// still holds an earlier, finished session (R18-weblib-L3-01): otherwise its start form stays enabled during the other
// start's POST and a second paid session starts beside it.
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lastSession } from '@web/lib/lastSession';
import { useRememberedSession } from '@web/lib/useRememberedSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = 'cc.pdf.5';

let host: HTMLElement;
let root: Root;
let hook: ReturnType<typeof useRememberedSession>;
beforeEach(() => {
  sessionStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

// Reports a status for the held session the way the Apply page's stream effect does.
function Probe({ status }: { status: string }) {
  hook = useRememberedSession(KEY);
  const { sessionId, onStatus } = hook.panel;
  useEffect(() => {
    if (sessionId) onStatus(status);
  }, [sessionId, status, onStatus]);
  return createElement('span', null, hook.busy ? 'busy' : 'idle');
}

describe('useRememberedSession honours a start marked by another mount', () => {
  it('is busy while another mount starts, even when holding an earlier finished session', async () => {
    lastSession(KEY).write('old-finished');
    await act(async () => {
      root.render(createElement(Probe, { status: 'done' }));
    });
    expect(host.textContent).toBe('idle');

    await act(async () => {
      lastSession(KEY).setStarting(true);
    });
    expect(host.textContent).toBe('busy');
    expect(hook.waiting).toBe(true);

    await act(async () => {
      lastSession(KEY).write('new-session');
      lastSession(KEY).setStarting(false);
    });
    expect(hook.waiting).toBe(false);
    expect(hook.panel.sessionId).toBe('new-session');
  });

  it('is busy while another mount starts after this mount own start finished', async () => {
    await act(async () => {
      root.render(createElement(Probe, { status: 'done' }));
    });
    await act(async () => hook.start());
    await act(async () => hook.panel.onSessionId('own-finished'));
    expect(host.textContent).toBe('idle');

    await act(async () => {
      lastSession(KEY).setStarting(true);
    });
    expect(host.textContent).toBe('busy');
  });

  it('is not waiting on its own start in flight', async () => {
    await act(async () => {
      root.render(createElement(Probe, { status: 'done' }));
    });
    await act(async () => hook.start());
    expect(hook.waiting).toBe(false);
    expect(hook.busy).toBe(true);
    await act(async () => hook.panel.onStartFailed());
    await act(async () => hook.panel.onStarting());
    expect(hook.waiting).toBe(false);
  });
});

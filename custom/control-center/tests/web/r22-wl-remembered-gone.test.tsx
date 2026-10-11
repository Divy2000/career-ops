// A session this mount started and that is later reported gone (deleted on the Sessions page) must give the start
// button back: the panel, left with no session id, reports the empty stream's 'queued', which must not read as a
// session still running (R22-weblib-L1-01).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useRememberedSession } from '@web/lib/useRememberedSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = 'cc.sponsor.acme';

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

function Probe() {
  hook = useRememberedSession(KEY);
  return createElement('span', null, hook.busy ? 'busy' : 'idle');
}

describe('useRememberedSession after its started session is gone', () => {
  it('is not busy once the session is gone and the idless panel reports queued', async () => {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => hook.start());
    await act(async () => hook.panel.onSessionId('s-done'));
    await act(async () => hook.panel.onStatus('done'));
    expect(host.textContent).toBe('idle');

    await act(async () => hook.panel.onStatus('gone'));
    expect(hook.panel.sessionId).toBeNull();
    await act(async () => hook.panel.onStatus('queued'));
    expect(hook.busy).toBe(false);
    expect(host.textContent).toBe('idle');
  });

  it('stays busy while a held session is queued', async () => {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => hook.start());
    await act(async () => hook.panel.onSessionId('s-live'));
    await act(async () => hook.panel.onStatus('queued'));
    expect(hook.busy).toBe(true);
  });
});

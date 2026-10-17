// A new session the panel reports (its own start form, or a fork) must not inherit the status of the session held before
// it (R28-feat-a-X-01): until the new stream reports, the old 'done' would read as not busy, so the page's New search /
// New draft control would let go of the paid session just started and allow a second one beside it.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lastSession } from '@web/lib/lastSession';
import { useRememberedSession } from '@web/lib/useRememberedSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = 'cc.discover.ai';

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

async function holdFinished(id: string) {
  lastSession(KEY).write(id);
  await act(async () => {
    root.render(createElement(Probe));
  });
  await act(async () => hook.panel.onStatus('done'));
  expect(host.textContent).toBe('idle');
}

describe('useRememberedSession with a new session id', () => {
  it('stays busy for a new session started from the panel before its stream reports a status', async () => {
    await holdFinished('old-finished');
    await act(async () => hook.panel.onStarting());
    expect(host.textContent).toBe('busy');

    await act(async () => hook.panel.onSessionId('new-session'));
    expect(hook.panel.sessionId).toBe('new-session');
    expect(host.textContent).toBe('busy');

    await act(async () => hook.panel.onStatus('done'));
    expect(host.textContent).toBe('idle');
  });

  it('stays busy for a fork before the forked session reports a status', async () => {
    await holdFinished('old-finished');
    await act(async () => hook.panel.onSessionId('forked'));
    expect(host.textContent).toBe('busy');
  });

  it('keeps the status already reported when a reply reports the same session again', async () => {
    await holdFinished('same');
    await act(async () => hook.panel.onStarting());
    // The stream already showed the reply's turn ending, so it reports nothing more: the held status must stand.
    await act(async () => hook.panel.onSessionId('same'));
    expect(host.textContent).toBe('idle');
  });
});

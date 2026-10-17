// A host that changes the key in place (a page kept mounted for another row or company) while a start is on its way:
// the start reports to the key it was made under, and the new key's page is neither held by it nor shown its session
// (R30-feat-c-X-01).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lastSession } from '@web/lib/lastSession';
import { useRememberedSession } from '@web/lib/useRememberedSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = 'cc.test.key-change.a';
const B = 'cc.test.key-change.b';

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

function Probe({ k }: { k: string }) {
  hook = useRememberedSession(k);
  return null;
}

async function startUnderAThenSwitchToB() {
  await act(async () => root.render(createElement(Probe, { k: A })));
  await act(async () => hook.start());
  await act(async () => hook.panel.onStarting());
  const first = hook.panel;
  await act(async () => root.render(createElement(Probe, { k: B })));
  return first;
}

describe('useRememberedSession when its key changes while a start is on its way', () => {
  it('Given a start sent under A, When the key changes to B, Then B is not busy and shows no panel', async () => {
    await startUnderAThenSwitchToB();
    expect(hook.busy).toBe(false);
    expect(hook.shown).toBe(false);
    expect(lastSession(A).starting()).toBe(true);
  });

  it('Given a start sent under A, When it reports after the key changed to B, Then A holds the session and B does not', async () => {
    const first = await startUnderAThenSwitchToB();
    await act(async () => first.onSessionId('sid-a'));
    expect(lastSession(A).read()).toBe('sid-a');
    expect(lastSession(A).starting()).toBe(false);
    expect(lastSession(B).read()).toBeNull();
    expect(hook.panel.sessionId).toBeNull();
    expect(hook.busy).toBe(false);
  });

  it('Given a start sent under A and a newer start under B, When A reports, Then A still gets its session and B keeps its start', async () => {
    const first = await startUnderAThenSwitchToB();
    await act(async () => hook.start());
    await act(async () => hook.panel.onStarting());
    await act(async () => first.onSessionId('sid-a'));
    expect(lastSession(A).read()).toBe('sid-a');
    expect(lastSession(A).starting()).toBe(false);
    expect(lastSession(B).read()).toBeNull();
    expect(lastSession(B).starting()).toBe(true);
    expect(hook.busy).toBe(true);
    await act(async () => hook.panel.onSessionId('sid-b'));
    expect(lastSession(B).read()).toBe('sid-b');
    expect(hook.panel.sessionId).toBe('sid-b');
  });

  it('Given a start sent under A, When it fails after the key changed to B, Then A lets go of its mark and B is untouched', async () => {
    const first = await startUnderAThenSwitchToB();
    await act(async () => hook.start());
    await act(async () => hook.panel.onStarting());
    await act(async () => first.onStartFailed());
    expect(lastSession(A).starting()).toBe(false);
    expect(lastSession(B).starting()).toBe(true);
    expect(hook.busy).toBe(true);
  });
});

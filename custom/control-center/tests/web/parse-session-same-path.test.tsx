import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cancelled = vi.hoisted(() => [] as string[]);
vi.mock('@web/lib/sessions', () => ({
  cancelSession: (id: string) => {
    cancelled.push(id);
    return Promise.resolve({});
  },
}));

const { useParseSession } = await import('@web/features/profile/parseSession');

type Parse = ReturnType<typeof useParseSession>;
let hook: Parse;
function Harness() {
  hook = useParseSession();
  return createElement('span', null, hook.parsing ? 'parsing' : 'idle');
}

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  cancelled.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(Harness)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

// The projects import re-picking the same PDF: the upload answers the same path, so two picks share it.
function pickSamePathTwice() {
  act(() => hook.begin('projects/x.pdf'));
  const first = hook.panelFor('projects/x.pdf');
  act(() => {
    hook.begin(null);
    hook.begin('projects/x.pdf');
  });
  const second = hook.panelFor('projects/x.pdf');
  return { first, second };
}

describe('useParseSession when a new pick gets the same upload path back', () => {
  it('keeps the new parse armed when the retired pick start fails late', () => {
    const { first } = pickSamePathTwice();
    act(() => first.onStartFailed());
    expect(hook.parsing).toBe(true);
  });

  it('cancels the retired pick session, not the new one, when the new start answers first', () => {
    const { first, second } = pickSamePathTwice();
    act(() => second.onSessionId('s2'));
    act(() => first.onSessionId('s1'));
    expect(cancelled).toEqual(['s1']);
    // The new parse's session is the one a later retire cancels.
    act(() => hook.begin(null));
    expect(cancelled).toEqual(['s1', 's2']);
  });

  it('ignores a retired pick panel ending status', () => {
    const { first, second } = pickSamePathTwice();
    act(() => second.onSessionId('s2'));
    act(() => first.onStatus('error'));
    expect(hook.parsing).toBe(true);
  });
});

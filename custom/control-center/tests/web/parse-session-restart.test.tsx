// A parse restarted from its panel (Parse again after a failed start, or a fork of a finished parse) is a paid session
// like the first one: leaving the import while its start is in flight cancels it once its id arrives, and the import
// counts as unsaved meanwhile (R30-feat-b-L1-01).
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

let hook: ReturnType<typeof useParseSession>;
function Harness() {
  hook = useParseSession();
  return null;
}

let host: HTMLElement;
let root: Root;
let mounted: boolean;
beforeEach(() => {
  cancelled.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(Harness)));
  mounted = true;
});
afterEach(() => {
  if (mounted) act(() => root.unmount());
  host.remove();
});
const leave = () => {
  act(() => root.unmount());
  mounted = false;
};

/** The upload's auto-started parse, as the panel reports it. */
function pickAndStart() {
  act(() => hook.begin('cv/x.pdf'));
  const panel = hook.panelFor('cv/x.pdf');
  act(() => panel.onStarting());
  return panel;
}

describe('useParseSession when the panel restarts the parse', () => {
  it('Given a failed start, When Parse is clicked again and the import is left before the id arrives, Then the restarted session is cancelled', () => {
    const panel = pickAndStart();
    act(() => panel.onStartFailed());
    expect(hook.parsing).toBe(false);
    act(() => panel.onStarting());
    expect(hook.parsing).toBe(true);
    leave();
    act(() => panel.onSessionId('s2'));
    expect(cancelled).toEqual(['s2']);
  });

  it('Given a start that answered an errored session, When Parse is clicked again and the import is left, Then the new session is cancelled once its id arrives', () => {
    const panel = pickAndStart();
    act(() => panel.onSessionId('s1'));
    act(() => panel.onStartFailed());
    act(() => panel.onStarting());
    leave();
    act(() => panel.onSessionId('s2'));
    expect(cancelled).toContain('s2');
  });

  it('Given a finished parse, When it is forked and the import is left before the fork answers, Then the fork is cancelled', () => {
    const panel = pickAndStart();
    act(() => panel.onSessionId('s1'));
    act(() => panel.onStatus('running'));
    act(() => panel.onStatus('done'));
    expect(hook.parsing).toBe(false);
    act(() => panel.onStarting());
    expect(hook.parsing).toBe(true);
    leave();
    act(() => panel.onSessionId('s4'));
    expect(cancelled).toEqual(['s4']);
  });

  it('Given a finished parse, When a restart fails, Then the import no longer counts as unsaved', () => {
    const panel = pickAndStart();
    act(() => panel.onSessionId('s1'));
    act(() => panel.onStatus('done'));
    act(() => panel.onStarting());
    act(() => panel.onStartFailed());
    expect(hook.parsing).toBe(false);
  });

  it('Given a restart whose id arrived, When the import is left while it runs, Then that session is cancelled', () => {
    const panel = pickAndStart();
    act(() => panel.onStartFailed());
    act(() => panel.onStarting());
    act(() => panel.onSessionId('s2'));
    act(() => panel.onStatus('running'));
    leave();
    expect(cancelled).toEqual(['s2']);
  });

  it('Given a parse waiting for the user, When a reply to it fails, Then the parse still counts as unsaved and leaving cancels it', () => {
    const panel = pickAndStart();
    act(() => panel.onSessionId('s1'));
    act(() => panel.onStatus('awaiting_user'));
    act(() => panel.onStarting());
    act(() => panel.onStartFailed());
    expect(hook.parsing).toBe(true);
    leave();
    expect(cancelled).toEqual(['s1']);
  });

  it('reports a fork or reply to the hook as a start', () => {
    act(() => hook.begin('cv/x.pdf'));
    expect(hook.panelFor('cv/x.pdf')).toMatchObject({ marksTurnStarts: true });
  });
});

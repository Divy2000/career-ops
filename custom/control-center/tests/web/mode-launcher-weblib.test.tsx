// ModeLauncher keeps the paid sessions it started (this browser tab) so leaving a page and coming back shows them again,
// whether or not the host page names a storage key, and a start still in flight when the page was left is shown as such.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Target } from '@web/lib/sessions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PanelProps = { mode: string; sessionId?: string | null; onSessionId?: (id: string) => void; onStatus?: (s: string) => void; onStarting?: () => void; onStartFailed?: () => void };
let panels: PanelProps[];
vi.mock('@web/components/SessionPanel', () => ({
  SessionPanel: (props: PanelProps) => {
    panels.push(props);
    return null;
  },
}));

const MODES = [
  { id: 'cover', label: 'Cover letter', prompt: 'Write it.' },
  { id: 'email', label: 'Outreach email', prompt: 'Draft it.' },
];

let host: HTMLElement;
let root: Root | null;

async function mount(props: { heading?: string; target?: Target; rememberAs?: string } = {}) {
  const { ModeLauncher } = await import('@web/components/ModeLauncher');
  panels = [];
  root = createRoot(host);
  await act(async () => root!.render(createElement(ModeLauncher, { heading: 'Outreach', modes: MODES, ...props })));
}
async function unmount() {
  await act(async () => root!.unmount());
  root = null;
}
const openPrompt = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Open prompt')!;
// The panels of the latest render, one per launch.
const shown = () => {
  const seen = new Map<string, PanelProps>();
  for (const p of panels) seen.set(`${p.mode}:${p.sessionId ?? 'new'}`, p);
  return [...seen.values()];
};
const last = () => panels.at(-1)!;
// Opens a prompt and returns its panel: the newest launch renders first.
const openNew = async () => {
  const before = panels.length;
  await act(async () => openPrompt().click());
  return panels[before]!;
};

beforeEach(() => {
  panels = [];
  sessionStorage.clear();
  // Starts in flight are counted in module memory (one page load): each test starts with a fresh page load.
  vi.resetModules();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(async () => {
  if (root) await unmount();
  host.remove();
});

describe('a launcher whose host page names no storage key', () => {
  it('shows a started session again after the page is left and reopened', async () => {
    await mount({ heading: 'Interview AI' });
    await act(async () => openPrompt().click());
    await act(async () => last().onSessionId!('sess-1'));
    await unmount();
    await mount({ heading: 'Interview AI' });
    expect(panels.some((p) => p.sessionId === 'sess-1')).toBe(true);
  });

  it('keeps sessions apart per target, so one application does not show another one\'s session', async () => {
    await mount({ target: { type: 'app', value: '4' } });
    await act(async () => openPrompt().click());
    await act(async () => last().onSessionId!('row4-sess'));
    await unmount();
    await mount({ target: { type: 'app', value: '7' } });
    expect(panels.some((p) => p.sessionId === 'row4-sess')).toBe(false);
    await unmount();
    await mount({ target: { type: 'app', value: '4' } });
    expect(panels.some((p) => p.sessionId === 'row4-sess')).toBe(true);
  });

  it('keeps launchers with different headings apart', async () => {
    await mount({ heading: 'AI drafts' });
    await act(async () => openPrompt().click());
    await act(async () => last().onSessionId!('drafts-1'));
    await unmount();
    await mount({ heading: 'Reply watch session' });
    expect(panels.some((p) => p.sessionId === 'drafts-1')).toBe(false);
  });
});

describe('a start still in flight when the launcher was left', () => {
  it('shows the start under way and holds off a second start until it reports', async () => {
    await mount({ rememberAs: 'cc.test.launch' });
    await act(async () => openPrompt().click());
    const starter = last();
    await act(async () => starter.onStarting!());
    await unmount();
    await mount({ rememberAs: 'cc.test.launch' });
    expect(host.textContent).toMatch(/starting/i);
    expect(openPrompt().disabled).toBe(true);
    // The unmounted panel's start answers now.
    await act(async () => starter.onSessionId!('late-1'));
    expect(panels.some((p) => p.sessionId === 'late-1')).toBe(true);
    expect(host.textContent).not.toMatch(/starting a session/i);
    expect(openPrompt().disabled).toBe(false);
  });

  it('gives the button back when the start fails after the launcher was left', async () => {
    await mount({ rememberAs: 'cc.test.launch' });
    await act(async () => openPrompt().click());
    const starter = last();
    await act(async () => starter.onStarting!());
    await unmount();
    await mount({ rememberAs: 'cc.test.launch' });
    expect(openPrompt().disabled).toBe(true);
    await act(async () => starter.onStartFailed!());
    expect(openPrompt().disabled).toBe(false);
    expect(host.textContent).not.toMatch(/starting a session/i);
  });

  it('does not block the launcher whose own panel is starting', async () => {
    await mount({ rememberAs: 'cc.test.launch' });
    await act(async () => openPrompt().click());
    await act(async () => last().onStarting!());
    expect(openPrompt().disabled).toBe(false);
    expect(host.textContent).not.toMatch(/starting a session/i);
  });

  it('holds off a second start until every start in flight has reported', async () => {
    await mount({ rememberAs: 'cc.test.launch' });
    const first = await openNew();
    await act(async () => first.onStarting!());
    const second = await openNew();
    await act(async () => second.onStarting!());
    await unmount();
    await mount({ rememberAs: 'cc.test.launch' });
    await act(async () => first.onSessionId!('first-1'));
    expect(openPrompt().disabled).toBe(true);
    await act(async () => second.onSessionId!('second-1'));
    expect(openPrompt().disabled).toBe(false);
  });

  it('tracks two starts opened within the same millisecond separately', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      await mount({ rememberAs: 'cc.test.launch' });
      const first = await openNew();
      await act(async () => first.onStarting!());
      const second = await openNew();
      await act(async () => second.onStarting!());
      await unmount();
      await mount({ rememberAs: 'cc.test.launch' });
      await act(async () => first.onSessionId!('first-1'));
      expect(openPrompt().disabled).toBe(true);
      await act(async () => second.onSessionId!('second-1'));
      expect(openPrompt().disabled).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not keep a session that failed to start, so coming back shows no dead panel', async () => {
    const { rememberedLaunches } = await import('@web/lib/lastSession');
    await mount({ rememberAs: 'cc.test.launch' });
    await act(async () => openPrompt().click());
    const starter = last();
    // SessionPanel on a 202 whose session is already errored: the id, then the failure.
    await act(async () => {
      starter.onStarting!();
      starter.onSessionId!('failed-1');
      starter.onStartFailed!();
    });
    expect(rememberedLaunches('cc.test.launch').read()).toEqual([]);
    // Settled once, not twice: another start still in flight keeps the launcher waiting.
    const other = await openNew();
    await act(async () => other.onStarting!());
    await unmount();
    await mount({ rememberAs: 'cc.test.launch' });
    expect(openPrompt().disabled).toBe(true);
    await act(async () => other.onStartFailed!());
    expect(openPrompt().disabled).toBe(false);
    await unmount();
    await mount({ rememberAs: 'cc.test.launch' });
    expect(panels.some((p) => p.sessionId === 'failed-1')).toBe(false);
  });

  it('keeps a session reported between the remount\'s first render and its effects', async () => {
    const { rememberedLaunches } = await import('@web/lib/lastSession');
    rememberedLaunches('cc.test.launch').add({ mode: 'cover', id: 'old-1' });
    const { ModeLauncher } = await import('@web/components/ModeLauncher');
    panels = [];
    root = createRoot(host);
    // The report lands while the remount renders, before its effects subscribe.
    let reported = false;
    const Probe = () => {
      if (!reported) {
        reported = true;
        rememberedLaunches('cc.test.launch').add({ mode: 'email', id: 'late-2' });
      }
      return null;
    };
    await act(async () => root!.render(createElement('div', null, createElement(ModeLauncher, { heading: 'Outreach', modes: MODES, rememberAs: 'cc.test.launch' }), createElement(Probe))));
    expect(shown().map((p) => p.sessionId).sort()).toEqual(['late-2', 'old-1']);
    expect(rememberedLaunches('cc.test.launch').read().map((l) => l.id).sort()).toEqual(['late-2', 'old-1']);
  });

  it('forgets a forked-from session in favour of the fork, and a deleted one', async () => {
    const { rememberedLaunches } = await import('@web/lib/lastSession');
    await mount({ rememberAs: 'cc.test.launch' });
    await act(async () => openPrompt().click());
    await act(async () => last().onSessionId!('first'));
    await act(async () => panels.filter((p) => p.sessionId === 'first').at(-1)!.onSessionId!('forked'));
    expect(rememberedLaunches('cc.test.launch').read().map((l) => l.id)).toEqual(['forked']);
    await act(async () => panels.filter((p) => p.sessionId === 'forked').at(-1)!.onStatus!('gone'));
    expect(rememberedLaunches('cc.test.launch').read()).toEqual([]);
  });
});

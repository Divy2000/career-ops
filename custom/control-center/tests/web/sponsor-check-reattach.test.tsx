// Sponsorship > Lookup > Run sponsorship check is a paid session that writes the company file and alert rows. Leaving
// the tab or the page and coming back must show the same check again, with the button off while it runs, so a second
// check of the same company cannot run beside it (SW6-web-b-04).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PanelProps = { mode: string; sessionId?: string | null; autoStart?: boolean; onSessionId?: (id: string) => void; onStatus?: (s: string, r: string | null) => void; onStartFailed?: () => void };
let panels: PanelProps[];
vi.mock('@web/components/SessionPanel', () => ({
  SessionPanel: (props: PanelProps) => {
    panels.push(props);
    return null;
  },
}));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: (props: { children?: unknown }) => createElement('a', null, props.children as string),
}));

let host: HTMLElement;
let root: Root;

async function open(company: string) {
  const { SponsorCheckLauncher } = await import('@web/features/sponsorship/LookupTab');
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(SponsorCheckLauncher, { key: company, company }))));
  await until(() => checkButton(), 'the check button');
}
const checkButton = () => [...host.querySelectorAll('button')].find((b) => /^(Run sponsorship check|Sponsorship check running)/.test(b.textContent ?? ''));
const lastPanel = () => panels.filter((p) => p.mode === 'sponsorship-check').pop();

beforeEach(() => {
  panels = [];
  sessionStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('Lookup > Run sponsorship check', () => {
  it('coming back shows the running check again for the same company, with the button off until it ends', async () => {
    await open('Acme Robotics');
    await act(async () => checkButton()!.click());
    expect(lastPanel()).toMatchObject({ autoStart: true });
    await act(async () => lastPanel()!.onSessionId!('check-1'));
    await act(async () => lastPanel()!.onStatus!('running', null));
    expect(checkButton()!.disabled).toBe(true);

    await act(async () => root.unmount());
    panels = [];
    await open('Acme Robotics');
    expect(lastPanel()).toMatchObject({ sessionId: 'check-1' });
    expect(lastPanel()!.autoStart).toBeFalsy();
    expect(checkButton()!.disabled).toBe(true);
    await act(async () => lastPanel()!.onStatus!('done', null));
    expect(checkButton()!.disabled).toBe(false);
  });

  it('another company has its own check: nothing is re-attached for it', async () => {
    await open('Acme Robotics');
    await act(async () => checkButton()!.click());
    await act(async () => lastPanel()!.onSessionId!('check-1'));
    await act(async () => root.unmount());
    panels = [];
    await open('Globex Payments');
    expect(lastPanel()).toBeUndefined();
    expect(checkButton()!.disabled).toBe(false);
  });

  it('names that slug alike keep separate checks: all-non-ASCII names, and AT&T against AT T', async () => {
    for (const [n, [first, second]] of [['株式会社テスト', 'Тест ООО'], ['AT&T', 'AT T']].entries()) {
      await open(first!);
      await act(async () => checkButton()!.click());
      await act(async () => lastPanel()!.onSessionId!(`s20261006-check${n}`));
      await act(async () => lastPanel()!.onStatus!('running', null));
      await act(async () => root.unmount());
      panels = [];
      await open(second!);
      expect(lastPanel(), `${second} after ${first}`).toBeUndefined();
      expect(checkButton()!.disabled).toBe(false);
      await act(async () => root.unmount());
      panels = [];
    }
    root = createRoot(host);
  });
});


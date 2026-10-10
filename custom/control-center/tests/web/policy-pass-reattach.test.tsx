// Sponsorship > Run AI policy pass: the pass is a paid session that acks its queued items only when it ends done.
// Leaving the page and coming back must show the same pass again, and keep the button off while it runs, so a second
// pass cannot be started over the same items (SW5-web-b-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
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

let host: HTMLElement;
let root: Root;

async function openPage() {
  const { SponsorshipPage } = await import('@web/features/sponsorship/SponsorshipPage');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const rootRoute = createRootRoute({ component: () => createElement(ConfirmProvider, null, createElement(Outlet)) });
  const sponsorship = createRoute({ getParentRoute: () => rootRoute, path: '/sponsorship', component: SponsorshipPage, validateSearch: () => ({ tab: 'overview' as const }) });
  const router = createRouter({ routeTree: rootRoute.addChildren([sponsorship]), history: createMemoryHistory({ initialEntries: ['/sponsorship'] }) });
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(RouterProvider, { router }))));
  await until(() => passButton(), 'the policy pass button');
}

const passButton = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Run AI policy pass') || b.textContent?.startsWith('Policy pass running'));
const lastPanel = () => panels.filter((p) => p.mode === 'immigration-policy').pop();

beforeEach(() => {
  panels = [];
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'not stubbed' }), { status: 404, headers: { 'content-type': 'application/json' } })));
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('Sponsorship AI policy pass', () => {
  it('coming back to the page shows the running pass again, with the button off until it ends', async () => {
    await openPage();
    await act(async () => passButton()!.click());
    expect(lastPanel()).toMatchObject({ autoStart: true });
    await act(async () => lastPanel()!.onSessionId!('pass-1'));
    await act(async () => lastPanel()!.onStatus!('running', null));
    expect(passButton()!.disabled).toBe(true);

    // Leave (the page unmounts) and come back.
    await act(async () => root.unmount());
    panels = [];
    await openPage();
    expect(lastPanel()).toMatchObject({ sessionId: 'pass-1' });
    expect(lastPanel()!.autoStart).toBeFalsy();
    expect(passButton()!.disabled).toBe(true);
    await act(async () => lastPanel()!.onStatus!('running', null));
    expect(passButton()!.disabled).toBe(true);

    // Once it ends, a new pass can start, as a new session.
    await act(async () => lastPanel()!.onStatus!('done', 'clean exit with output'));
    expect(passButton()!.disabled).toBe(false);
    await act(async () => passButton()!.click());
    expect(lastPanel()).toMatchObject({ autoStart: true });
    expect(lastPanel()!.sessionId ?? null).toBeNull();
  });

  it('a remembered pass the server no longer has (deleted on the Sessions page) is let go, and the button comes back', async () => {
    sessionStorage.setItem('cc.sponsorship.policyPass', 'pass-deleted');
    await openPage();
    expect(lastPanel()).toMatchObject({ sessionId: 'pass-deleted' });
    expect(passButton()!.disabled).toBe(true);
    await act(async () => lastPanel()!.onStatus!('gone', null));
    expect(passButton()!.disabled).toBe(false);
    expect(sessionStorage.getItem('cc.sponsorship.policyPass')).toBeNull();
  });

  it('a pass that could not start leaves the button usable again', async () => {
    await openPage();
    await act(async () => passButton()!.click());
    expect(passButton()!.disabled).toBe(true);
    await act(async () => lastPanel()!.onStartFailed!());
    expect(passButton()!.disabled).toBe(false);
    expect(passButton()!.textContent).toContain('Run AI policy pass');
  });

  it('after a failed start, a pass started from the panel itself turns the button off again while it runs (SW7-web-b-01)', async () => {
    await openPage();
    await act(async () => passButton()!.click());
    await act(async () => lastPanel()!.onStartFailed!());
    expect(passButton()!.disabled).toBe(false);
    // The panel's own Start session, once pending.json is fixed.
    await act(async () => lastPanel()!.onSessionId!('pass-retry'));
    await act(async () => lastPanel()!.onStatus!('running', null));
    expect(passButton()!.disabled).toBe(true);
    expect(sessionStorage.getItem('cc.sponsorship.policyPass')).toBe('pass-retry');
  });

  it('a start that came back as an errored session, then answered in its panel, turns the button off while that turn runs (SW7-web-b-01)', async () => {
    await openPage();
    await act(async () => passButton()!.click());
    await act(async () => lastPanel()!.onSessionId!('pass-error'));
    await act(async () => lastPanel()!.onStartFailed!());
    await act(async () => lastPanel()!.onStatus!('error', 'no token'));
    expect(passButton()!.disabled).toBe(false);
    await act(async () => lastPanel()!.onStatus!('running', null));
    expect(passButton()!.disabled).toBe(true);
  });
});

// Application > Sponsorship > Refresh check starts the same paid sponsorship-check session as Sponsorship > Lookup,
// which writes data/immigration/companies/<company>.md. Both places keep one remembered check per company: leaving
// the tab and coming back shows the running check, and a check started in either place keeps the other's button off,
// so two checks of one company cannot run at once (SW8-web-a-04).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationDetail } from '@shared/api';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PanelProps = { mode: string; sessionId?: string | null; autoStart?: boolean; initialPrompt?: string; startLabel?: string; onSessionId?: (id: string) => void; onStatus?: (s: string, r: string | null) => void; onStartFailed?: () => void };
let panels: PanelProps[];
vi.mock('@web/components/SessionPanel', () => ({
  // Like the real panel, one with no session shows its start form, whose button carries startLabel.
  SessionPanel: (props: PanelProps) => {
    panels.push(props);
    return props.sessionId || props.autoStart ? null : createElement('button', { type: 'submit' }, props.startLabel ?? 'Start session');
  },
  StatusLabel: () => null,
}));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: (props: { children?: unknown }) => createElement('a', null, props.children as string),
}));

let host: HTMLElement;
let root: Root;

async function render(element: ReturnType<typeof createElement>) {
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient() }, element)));
}
// GET /api/tracker/7: a row with no report and no company sponsorship file yet.
const detail = (company: string): ApplicationDetail => ({
  row: {
    num: 7, date: '2026-10-01', company, role: 'Robotics Engineer', score: 4.2, scoreRaw: '4.2/5', status: 'Evaluated', pdf: false, pdfRaw: '', report: null, reportLabel: null,
    notes: '', location: null, url: null, posted: null, lastContact: null, summary: null, reportState: 'none',
  },
  report: { kind: 'none' },
  timeline: { statusLog: [], followups: [], pin: null },
  companyHistory: [],
  sponsorship: { companyFile: null, alert: null, error: null },
});
let company = 'Acme Robotics';

/** Opens /tracker/7 and its Sponsorship tab, the way a user reaches Refresh check. */
async function openApplication(name: string) {
  company = name;
  const { ApplicationPage } = await import('@web/features/tracker/ApplicationPage');
  const rootRoute = createRootRoute();
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/tracker/$n', component: ApplicationPage });
  const router = createRouter({ routeTree: rootRoute.addChildren([page]), history: createMemoryHistory({ initialEntries: ['/tracker/7'] }) });
  await render(createElement(RouterProvider, { router }));
  await openTab('Sponsorship');
  await until(() => refreshButton(), 'the refresh button');
}
async function openTab(label: string) {
  await until(() => tab(label), `the ${label} tab`);
  await act(async () => tab(label)!.click());
}
const tab = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === label);
const refreshButton = () => [...host.querySelectorAll('button')].find((b) => /^(Refresh check|Sponsorship check running)/.test(b.textContent ?? ''));
const lastPanel = () => panels.filter((p) => p.mode === 'sponsorship-check').pop();
async function leave() {
  await act(async () => root.unmount());
  panels = [];
}

beforeEach(() => {
  panels = [];
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/tracker/7'
        ? new Response(JSON.stringify(detail(company)), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ error: 'not stubbed' }), { status: 404, headers: { 'content-type': 'application/json' } }),
    ),
  );
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('Application > Sponsorship > Refresh check', () => {
  it('coming back to the tab shows the running check again, with the button off until it ends', async () => {
    await openApplication('Acme Robotics');
    expect(lastPanel()).toBeUndefined();
    await act(async () => refreshButton()!.click());
    expect(lastPanel()).toMatchObject({ autoStart: true });
    expect(lastPanel()!.initialPrompt).toContain('Check visa sponsorship for Acme Robotics');
    await act(async () => lastPanel()!.onSessionId!('check-app'));
    await act(async () => lastPanel()!.onStatus!('running', null));
    expect(refreshButton()!.disabled).toBe(true);

    await openTab('Report');
    expect(refreshButton()).toBeUndefined();
    panels = [];
    await openTab('Sponsorship');
    await until(() => refreshButton(), 'the refresh button');
    expect(lastPanel()).toMatchObject({ sessionId: 'check-app' });
    expect(lastPanel()!.autoStart).toBeFalsy();
    expect(refreshButton()!.disabled).toBe(true);
    await act(async () => lastPanel()!.onStatus!('done', 'clean exit with output'));
    expect(refreshButton()!.disabled).toBe(false);
    expect(refreshButton()!.textContent).toContain('Refresh check');
  });

  it('leaving the tab while the check is still starting keeps it: the button stays off, and its session shows once it is created', async () => {
    await openApplication('Acme Robotics');
    await act(async () => refreshButton()!.click());
    const starting = lastPanel()!;
    expect(starting).toMatchObject({ autoStart: true });

    // The user switches tabs before POST /api/sessions answers; the start goes on and reports the id afterwards.
    await openTab('Report');
    panels = [];
    await openTab('Sponsorship');
    await until(() => refreshButton(), 'the refresh button');
    expect(refreshButton()!.disabled).toBe(true);
    expect(panels.some((p) => p.mode === 'sponsorship-check' && p.autoStart)).toBe(false);

    await act(async () => starting.onSessionId!('check-app'));
    expect(lastPanel()).toMatchObject({ sessionId: 'check-app' });
    expect(refreshButton()!.disabled).toBe(true);
    await act(async () => lastPanel()!.onStatus!('done', 'clean exit with output'));
    expect(refreshButton()!.disabled).toBe(false);
  });

  it('a start that fails after leaving the tab gives the button back', async () => {
    await openApplication('Acme Robotics');
    await act(async () => refreshButton()!.click());
    const starting = lastPanel()!;
    await openTab('Report');
    await openTab('Sponsorship');
    await until(() => refreshButton(), 'the refresh button');
    expect(refreshButton()!.disabled).toBe(true);

    await act(async () => starting.onStartFailed!());
    expect(refreshButton()!.disabled).toBe(false);
    expect(refreshButton()!.textContent).toContain('Refresh check');
  });

  it('a check started on Sponsorship > Lookup shows here, with the button off, and the other way round', async () => {
    const { SponsorCheckLauncher } = await import('@web/features/sponsorship/LookupTab');
    await render(createElement(SponsorCheckLauncher, { company: 'Acme Robotics' }));
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Run sponsorship check'))!.click());
    await act(async () => lastPanel()!.onSessionId!('check-lookup'));
    await leave();

    await openApplication('acme robotics ');
    expect(lastPanel()).toMatchObject({ sessionId: 'check-lookup' });
    expect(refreshButton()!.disabled).toBe(true);
    await act(async () => lastPanel()!.onStatus!('done', 'clean exit with output'));
    await act(async () => refreshButton()!.click());
    await act(async () => lastPanel()!.onSessionId!('check-app'));
    await leave();

    await render(createElement(SponsorCheckLauncher, { company: 'Acme Robotics' }));
    expect(lastPanel()).toMatchObject({ sessionId: 'check-app' });
    expect([...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Sponsorship check running'))!.disabled).toBe(true);
  });

  it('a check Lookup started under the DOL entity name keeps the button off for the tracker name of that company, and the other way round (R13-feat-c-L1-02)', async () => {
    const { SponsorCheckLauncher } = await import('@web/features/sponsorship/LookupTab');
    await render(createElement(SponsorCheckLauncher, { company: 'STRIPE, INC.' }));
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Run sponsorship check'))!.click());
    await act(async () => lastPanel()!.onSessionId!('check-lookup'));
    await leave();

    await openApplication('Stripe');
    expect(lastPanel()).toMatchObject({ sessionId: 'check-lookup' });
    expect(refreshButton()!.disabled).toBe(true);
    await act(async () => lastPanel()!.onStatus!('done', 'clean exit with output'));
    await act(async () => refreshButton()!.click());
    await act(async () => lastPanel()!.onSessionId!('check-app'));
    await leave();

    await render(createElement(SponsorCheckLauncher, { company: 'STRIPE, INC.' }));
    expect(lastPanel()).toMatchObject({ sessionId: 'check-app' });
    expect([...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Sponsorship check running'))!.disabled).toBe(true);
  });
});

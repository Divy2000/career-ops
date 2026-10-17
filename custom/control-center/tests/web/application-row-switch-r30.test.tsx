// The Application page stays mounted when only its row changes to a row already read (/tracker/4 back to /tracker/7),
// and so does its tab. A paid
// session started on one row whose start is still on its way when the user changes rows must be remembered under the
// row it was started on, and must not show on, or hold, the row the user went to (R30-feat-c-X-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationDetail } from '@shared/api';
import { lastSession } from '@web/lib/lastSession';
import { sponsorCheckKey } from '@web/lib/sponsorCheck';
import { sponsorCheckCompany } from '@shared/company-slug';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PanelProps = { mode: string; sessionId?: string | null; autoStart?: boolean; onSessionId?: (id: string) => void; onStatus?: (s: string, r: string | null) => void; onStarting?: () => void; onStartFailed?: () => void };
let panels: PanelProps[];
vi.mock('@web/components/SessionPanel', () => ({
  SessionPanel: (props: PanelProps) => {
    panels.push(props);
    return props.sessionId || props.autoStart ? null : createElement('button', { type: 'submit' }, 'Start session');
  },
  StatusLabel: () => null,
}));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: (props: { children?: unknown }) => createElement('a', null, props.children as string),
}));

const COMPANIES: Record<string, string> = { '4': 'Acme Robotics', '7': 'Beta Labs' };
const detail = (num: number): ApplicationDetail => ({
  row: {
    num, date: '2026-10-01', company: COMPANIES[String(num)]!, role: 'Robotics Engineer', score: 4.2, scoreRaw: '4.2/5', status: 'Evaluated', pdf: false, pdfRaw: '', report: null, reportLabel: null,
    notes: '', location: null, url: null, posted: null, lastContact: null, summary: null, reportState: 'none',
  },
  report: { kind: 'none' },
  timeline: { statusLog: [], followups: [], pin: null },
  companyHistory: [],
  sponsorship: { companyFile: null, alert: null, error: null, companiesError: null },
});

let host: HTMLElement;
let root: Root;
let router: ReturnType<typeof createRouter>;

async function openRow(n: number) {
  const { ApplicationPage } = await import('@web/features/tracker/ApplicationPage');
  const rootRoute = createRootRoute();
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/tracker/$n', component: ApplicationPage });
  router = createRouter({ routeTree: rootRoute.addChildren([page]), history: createMemoryHistory({ initialEntries: [`/tracker/${n}`] }) });
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(RouterProvider, { router }))));
}
async function goToRow(n: number) {
  await act(async () => router.navigate({ to: '/tracker/$n', params: { n: String(n) } }));
  await until(() => host.querySelector('h1')?.textContent === COMPANIES[String(n)], `row ${n}`);
}
async function openTab(label: string) {
  await until(() => tab(label), `the ${label} tab`);
  await act(async () => tab(label)!.click());
}
const tab = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === label);
const button = (re: RegExp) => [...host.querySelectorAll('button')].find((b) => re.test(b.textContent ?? ''));
const refreshButton = () => button(/^(Refresh check|Sponsorship check running|Sponsorship check needs your reply)/);
const checkKey = (company: string) => sponsorCheckKey(sponsorCheckCompany(company));

beforeEach(() => {
  panels = [];
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const m = /^\/api\/tracker\/(\d+)$/.exec(url);
      return m && COMPANIES[m[1]!]
        ? new Response(JSON.stringify(detail(Number(m[1]))), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ error: 'not stubbed' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('Application page, changing rows while a start is on its way', () => {
  it('Given a sponsorship check starting on row 4, When the user goes back to row 7 before it answers, Then the session is remembered for row 4 only and row 7 stays free', async () => {
    await openRow(7);
    await goToRow(4);
    await openTab('Sponsorship');
    await until(() => refreshButton(), 'the refresh button');
    await act(async () => refreshButton()!.click());
    const starting = panels.filter((p) => p.mode === 'sponsorship-check').pop()!;
    expect(starting).toMatchObject({ autoStart: true });

    await goToRow(7);
    await until(() => refreshButton(), 'the refresh button on row 7');
    expect(refreshButton()!.disabled).toBe(false);
    panels = [];
    await act(async () => starting.onSessionId!('check-acme'));

    expect(lastSession(checkKey('Acme Robotics')).read()).toBe('check-acme');
    expect(lastSession(checkKey('Acme Robotics')).starting()).toBe(false);
    expect(lastSession(checkKey('Beta Labs')).read()).toBeNull();
    expect(panels.some((p) => p.sessionId === 'check-acme')).toBe(false);
    expect(refreshButton()!.disabled).toBe(false);
  });

  it('Given an outreach session starting on row 4, When the user goes back to row 7 before it answers, Then it is remembered for row 4 only and does not show on row 7', async () => {
    await openRow(7);
    await goToRow(4);
    await openTab('Outreach');
    await until(() => button(/^Open prompt$/), 'the Open prompt button');
    await act(async () => button(/^Open prompt$/)!.click());
    const starting = panels.filter((p) => p.mode === 'cover').pop()!;
    await act(async () => starting.onStarting!());

    await goToRow(7);
    await until(() => button(/^Open prompt$/), 'the Open prompt button on row 7');
    expect(panels.filter((p) => p.mode === 'cover').pop()?.onSessionId).not.toBe(starting.onSessionId);
    expect(button(/^Open prompt$/)!.disabled).toBe(false);
    panels = [];
    await act(async () => starting.onSessionId!('cover-acme'));

    expect(sessionStorage.getItem('cc.application.4.outreach') ?? '').toContain('cover-acme');
    expect(sessionStorage.getItem('cc.application.7.outreach') ?? '').not.toContain('cover-acme');
    expect(panels.some((p) => p.sessionId === 'cover-acme')).toBe(false);
  });
});

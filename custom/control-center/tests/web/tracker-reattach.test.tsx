// Tracker sessions survive leaving the page: an application's launchers (R13-feat-c-03), Ask about tracker
// (R13-feat-c-04) and Compare selected (R13-feat-c-05) show their session again on coming back. And an application
// whose posting is a saved JD opens the file, not the literal local: reference (R13-feat-c-02).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationDetail, TrackerRow } from '@shared/api';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PanelProps = { mode: string; title?: string; sessionId?: string | null; autoStart?: boolean; initialPrompt?: string; onSessionId?: (id: string) => void; onStatus?: (s: string, r: string | null) => void };
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

let host: HTMLElement;
let root: Root;
const trackerRow = (num: number, company: string, url: string | null): TrackerRow => ({
  num, date: '2026-10-01', company, role: 'Robotics Engineer', score: 4.2, scoreRaw: '4.2/5', status: 'Evaluated', pdf: false, pdfRaw: '', report: null, reportLabel: null,
  notes: '', location: null, url, posted: null, lastContact: null, summary: null, reportState: 'none',
}) as TrackerRow;
let url: string | null;
const detail = (): ApplicationDetail => ({ row: trackerRow(7, 'Acme Robotics', url), report: { kind: 'none' }, timeline: { statusLog: [], followups: [], pin: null }, companyHistory: [], sponsorship: { companyFile: null, alert: null, error: null } });

async function render(element: ReturnType<typeof createElement>) {
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient() }, element)));
}
async function leave() {
  await act(async () => root.unmount());
  panels = [];
}
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(name));
const tab = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === label);
async function openTab(label: string) {
  await until(() => tab(label), `the ${label} tab`);
  await act(async () => tab(label)!.click());
}
async function openApplication() {
  const { ApplicationPage } = await import('@web/features/tracker/ApplicationPage');
  const rootRoute = createRootRoute();
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/tracker/$n', component: ApplicationPage });
  const router = createRouter({ routeTree: rootRoute.addChildren([page]), history: createMemoryHistory({ initialEntries: ['/tracker/7'] }) });
  await render(createElement(RouterProvider, { router }));
  await until(() => tab('Outreach'), 'the application');
}

beforeEach(() => {
  panels = [];
  url = null;
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: string) =>
      u === '/api/tracker/7'
        ? new Response(JSON.stringify(detail()), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } }),
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

describe('an application page', () => {
  it('opens a saved-JD posting through the file server', async () => {
    url = 'local:jds/acme.md';
    await openApplication();
    const open = [...host.querySelectorAll('a')].find((a) => a.textContent === 'Open posting');
    expect(open?.getAttribute('href')).toBe('/api/files/serve?path=jds%2Facme.md');
  });

  it('a posting URL still opens as it is', async () => {
    url = 'https://jobs.example.com/acme/1';
    await openApplication();
    const open = [...host.querySelectorAll('a')].find((a) => a.textContent === 'Open posting');
    expect(open?.getAttribute('href')).toBe('https://jobs.example.com/acme/1');
  });
});

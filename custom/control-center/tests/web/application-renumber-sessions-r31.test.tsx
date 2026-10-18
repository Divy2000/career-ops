// An application page re-attaches the AI sessions it remembers starting. A delete elsewhere renumbers the tracker, and
// the company that inherits a row number must not get the sessions started for the row that held it before: a reply
// there would continue the other application's session (R31-feat-c-L2-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationDetail } from '@shared/api';
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

let COMPANIES: Record<string, string>;
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
async function openTab(label: string) {
  await until(() => tab(label), `the ${label} tab`);
  await act(async () => tab(label)!.click());
}
const tab = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === label);
const button = (re: RegExp) => [...host.querySelectorAll('button')].find((b) => re.test(b.textContent ?? ''));

beforeEach(() => {
  panels = [];
  COMPANIES = { '7': 'Acme Robotics' };
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

describe('Application page after a delete renumbers the tracker', () => {
  it('Given an outreach session started on row 7, When a delete gives row 7 to another company, Then that company\'s page does not re-attach it', async () => {
    await openRow(7);
    await until(() => host.querySelector('h1')?.textContent === 'Acme Robotics', 'row 7');
    await openTab('Outreach');
    await until(() => button(/^Open prompt$/), 'the Open prompt button');
    await act(async () => button(/^Open prompt$/)!.click());
    const started = panels.filter((p) => p.mode === 'cover').pop()!;
    await act(async () => started.onStarting!());
    await act(async () => started.onSessionId!('cover-acme'));
    await act(async () => root.unmount());

    // A row before Acme was deleted elsewhere: Acme is now #6 and Beta Labs inherits #7.
    COMPANIES = { '6': 'Acme Robotics', '7': 'Beta Labs' };
    panels = [];
    await openRow(7);
    await until(() => host.querySelector('h1')?.textContent === 'Beta Labs', 'row 7 after the renumber');
    await openTab('Outreach');
    await until(() => button(/^Open prompt$/), 'the Open prompt button on Beta Labs');
    expect(panels.some((p) => p.sessionId === 'cover-acme')).toBe(false);
  });
});

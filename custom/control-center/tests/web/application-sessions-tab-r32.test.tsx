// The Sessions tab lists the sessions targeting this row. A deleted row's number can be handed to a later addition, and
// that application's page must not list the sessions started for the deleted row: each session records the row it was
// started on, and the tab matches it as well as the number (R31-feat-c-L2-01b).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationDetail, SessionMeta } from '@shared/api';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@web/components/SessionPanel', () => ({ SessionPanel: () => null, StatusLabel: () => null }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: (props: { children?: unknown }) => createElement('a', { 'data-testid': 'session-link' }, props.children as string),
}));

const ROW = { company: 'Beta Labs', role: 'Robotics Engineer', report: 12 };
const detail = (num: number): ApplicationDetail => ({
  row: {
    num, date: '2026-10-01', company: ROW.company, role: ROW.role, score: 4.2, scoreRaw: '4.2/5', status: 'Evaluated', pdf: false, pdfRaw: '', report: ROW.report, reportLabel: '012',
    notes: '', location: null, url: null, posted: null, lastContact: null, summary: null, reportState: 'none',
  },
  report: { kind: 'none' },
  timeline: { statusLog: [], followups: [], pin: null },
  companyHistory: [],
  sponsorship: { companyFile: null, alert: null, error: null, companiesError: null },
});
const session = (mode: string, target: SessionMeta['target']) => ({ id: `s-${mode}`, mode, status: 'done', updatedAt: '2026-10-02T10:00:00.000Z', target }) as unknown as SessionMeta;

let SESSIONS: SessionMeta[];
let host: HTMLElement;
let root: Root;

async function openSessionsTab(n: number) {
  const { ApplicationPage } = await import('@web/features/tracker/ApplicationPage');
  const rootRoute = createRootRoute();
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/tracker/$n', component: ApplicationPage });
  const router = createRouter({ routeTree: rootRoute.addChildren([page]), history: createMemoryHistory({ initialEntries: [`/tracker/${n}`] }) });
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(RouterProvider, { router }))));
  const tab = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === 'Sessions');
  await until(() => tab(), 'the Sessions tab');
  await act(async () => tab()!.click());
  await until(() => host.textContent?.includes('Sessions for this application'), 'the Sessions card');
}
const listed = () => [...host.querySelectorAll('.bullets [data-testid="session-link"]')].map((a) => a.textContent);

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/sessions') return json(SESSIONS);
      const m = /^\/api\/tracker\/(\d+)$/.exec(url);
      if (m) return json(detail(Number(m[1])));
      return new Response(JSON.stringify({ error: 'not stubbed' }), { status: 404, headers: { 'content-type': 'application/json' } });
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

describe('Application > Sessions after a row number is handed to another application', () => {
  it('Given a session started on deleted row 7 (Acme), When Beta Labs now holds #7, Then its Sessions tab does not list it', async () => {
    SESSIONS = [session('cover', { type: 'app', value: '7', row: { company: 'Acme Robotics', role: 'Robotics Engineer', report: 9 } }), session('interview-prep', { type: 'app', value: '7', row: { ...ROW } })];
    await openSessionsTab(7);
    await until(() => listed().length > 0, 'the listed sessions');
    expect(listed()).toEqual(['interview-prep']);
  });

  it('Given sessions started on Beta Labs at #7 and one from before rows were recorded, When its Sessions tab opens, Then both are listed', async () => {
    SESSIONS = [session('cover', { type: 'app', value: '7', row: { ...ROW } }), session('interview-prep', { type: 'app', value: '7' }), session('pdf', { type: 'app', value: '8', row: { ...ROW } })];
    await openSessionsTab(7);
    await until(() => listed().length > 0, 'the listed sessions');
    expect(listed()).toEqual(['cover', 'interview-prep']);
  });
});

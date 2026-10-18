// Application > Open posting links the row's posting through postingHref (R35-web1-FC-02). A tracker URL that is not
// an http(s) URL or a saved JD (javascript:, data:) gives no Open posting link at all rather than an anchor to nowhere.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationDetail } from '@shared/api';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@web/components/SessionPanel', () => ({ SessionPanel: () => null, StatusLabel: () => null }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: (props: { children?: unknown }) => createElement('a', null, props.children as string),
}));

let host: HTMLElement;
let root: Root;
let url: string;
const detail = (): ApplicationDetail => ({
  row: {
    num: 7, date: '2026-10-01', company: 'Acme', role: 'Robotics Engineer', score: 4.2, scoreRaw: '4.2/5', status: 'Evaluated', pdf: false, pdfRaw: '', report: null, reportLabel: null,
    notes: '', location: null, url, posted: null, lastContact: null, summary: null, reportState: 'none',
  },
  report: { kind: 'none' },
  timeline: { statusLog: [], followups: [], pin: null },
  companyHistory: [],
  sponsorship: { companyFile: null, alert: null, error: null, companiesError: null },
});

async function open(posting: string) {
  url = posting;
  const { ApplicationPage } = await import('@web/features/tracker/ApplicationPage');
  const rootRoute = createRootRoute();
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/tracker/$n', component: ApplicationPage });
  const router = createRouter({ routeTree: rootRoute.addChildren([page]), history: createMemoryHistory({ initialEntries: ['/tracker/7'] }) });
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(RouterProvider, { router }))));
  await until(() => host.textContent?.includes('Robotics Engineer'), 'the application header');
}
const openPosting = () => [...host.querySelectorAll('a')].find((a) => a.textContent?.trim() === 'Open posting');

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: string) =>
      u === '/api/tracker/7'
        ? new Response(JSON.stringify(detail()), { status: 200, headers: { 'content-type': 'application/json' } })
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

describe('Application > Open posting', () => {
  it('given an http(s) posting URL, then Open posting links to it', async () => {
    await open('https://jobs.example.com/acme/1');
    expect(openPosting()?.getAttribute('href')).toBe('https://jobs.example.com/acme/1');
  });

  for (const posting of ['javascript:alert(document.domain)', 'data:text/html,<script>alert(1)</script>']) {
    it(`given the posting reference ${posting}, then there is no Open posting link`, async () => {
      await open(posting);
      expect(openPosting()).toBeUndefined();
    });
  }
});

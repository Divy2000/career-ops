// Every session an application page starts for its row names the application it showed under that number: a reindex
// can hand the number to another application, and the server refuses (409) a start whose row is no longer that one
// (R35-sessions-FC-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationDetail } from '@shared/api';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PanelProps = { mode: string; target?: unknown };
let panels: PanelProps[];
vi.mock('@web/components/SessionPanel', () => ({
  SessionPanel: (props: PanelProps) => {
    panels.push(props);
    return null;
  },
  StatusLabel: () => null,
}));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: (props: { children?: unknown }) => createElement('a', null, props.children as string),
}));

const detail: ApplicationDetail = {
  row: {
    num: 7, date: '2026-10-01', company: 'Acme Robotics', role: 'Robotics Engineer', score: 4.2, scoreRaw: '4.2/5', status: 'Evaluated', pdf: false, pdfRaw: '', report: 12, reportLabel: null,
    notes: '', location: null, url: null, posted: null, lastContact: null, summary: null, reportState: 'none',
  },
  report: { kind: 'none' },
  timeline: { statusLog: [], followups: [], pin: null },
  companyHistory: [],
  sponsorship: { companyFile: null, alert: null, error: null, companiesError: null },
};

let host: HTMLElement;
let root: Root;

beforeEach(async () => {
  panels = [];
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/tracker/7') return json(detail);
      if (url === '/api/tracker/7/documents') return json({ files: [], jds: [], indexPresent: false, report: 12 });
      return json([]);
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  const { ApplicationPage } = await import('@web/features/tracker/ApplicationPage');
  const rootRoute = createRootRoute();
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/tracker/$n', component: ApplicationPage });
  const router = createRouter({ routeTree: rootRoute.addChildren([page]), history: createMemoryHistory({ initialEntries: ['/tracker/7'] }) });
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(RouterProvider, { router }))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const tab = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === label);
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

describe('Application page: row-scoped starts name the application shown (R35-sessions-FC-01)', () => {
  for (const label of ['Documents', 'Outreach', 'Interview', 'Offer & Outcome']) {
    it(`the ${label} tab's launcher starts on row 7 expecting Acme Robotics`, async () => {
      await until(() => tab(label), `the ${label} tab`);
      await act(async () => tab(label)!.click());
      await until(() => button('Open prompt'), 'the launcher');
      await act(async () => button('Open prompt')!.click());
      await until(() => panels.length > 0, 'a session panel');
      expect(panels.at(-1)!.target).toEqual({ type: 'app', value: '7', expect: { company: 'Acme Robotics', role: 'Robotics Engineer', report: 12 } });
    });
  }
});

// A reply to (or fork of) a finished remembered session starts a paid turn, but while its request is in flight the
// session still reads as finished: a host button that starts a new session of the same kind would come back on, here
// and on a page mounted meanwhile, and start a second paid session beside the turn. Each host asks its panel to report
// such a turn as a start (marksTurnStarts) and keeps its start button off until the server answered.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationDetail, TrackerRow } from '@shared/api';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PanelProps = {
  mode: string;
  sessionId?: string | null;
  autoStart?: boolean;
  marksTurnStarts?: boolean;
  onSessionId?: (id: string) => void;
  onStatus?: (s: string, r: string | null) => void;
  onStarting?: () => void;
  onStartFailed?: () => void;
};
let panels: PanelProps[];
vi.mock('@web/components/SessionPanel', () => ({
  // With a session it shows its reply form, whose Send carries the turn.
  SessionPanel: (props: PanelProps) => {
    panels.push(props);
    return props.sessionId ? createElement('button', { type: 'button', 'data-reply': props.mode }, 'Send') : null;
  },
  StatusLabel: () => null,
}));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: (props: { children?: unknown }) => createElement('a', null, props.children as string),
}));

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const trackerRow = (num: number, company: string): TrackerRow =>
  ({
    num, date: '2026-10-01', company, role: 'Robotics Engineer', score: 4.2, scoreRaw: '4.2/5', status: 'Evaluated', pdf: false, pdfRaw: '', report: null, reportLabel: null,
    notes: '', location: null, url: null, posted: null, lastContact: null, summary: null, reportState: 'none',
  }) as TrackerRow;
const detail = (): ApplicationDetail => ({ row: trackerRow(7, 'Acme Robotics'), report: { kind: 'none' }, timeline: { statusLog: [], followups: [], pin: null }, companyHistory: [], sponsorship: { companyFile: null, alert: null, error: null } });

let host: HTMLElement;
let root: Root | undefined;
// The Application page stays mounted while its tabs switch.
let applicationOpen: boolean;
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const buttonLike = (re: RegExp) => [...host.querySelectorAll('button')].find((b) => re.test(b.textContent ?? ''));

interface Host {
  name: string;
  mode: string;
  /** Mounts the host (again, after leaving). */
  open(): Promise<void>;
  /** Leaves the host, as switching away does. */
  leave(): Promise<void>;
  /** Starts a session the way the user does here, before the panel reports it. */
  begin(): Promise<void>;
  /** Whether the user can start another session of this kind here now. */
  canStartAnother(): boolean;
}

async function mount(element: ReturnType<typeof createElement>) {
  root = createRoot(host);
  await act(async () => root!.render(createElement(QueryClientProvider, { client: client() }, element)));
}
async function unmount() {
  await act(async () => root!.unmount());
  root = undefined;
  panels = [];
}
const clickStart = (re: RegExp) => async () => {
  await act(async () => buttonLike(re)!.click());
};

const tab = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === label);
async function openTab(label: string) {
  await until(() => tab(label), `the ${label} tab`);
  await act(async () => tab(label)!.click());
}

const HOSTS: Host[] = [
  {
    name: 'Sponsorship > Lookup > Run sponsorship check',
    mode: 'sponsorship-check',
    async open() {
      const { SponsorCheckLauncher } = await import('@web/features/sponsorship/LookupTab');
      await mount(createElement(SponsorCheckLauncher, { company: 'Acme Robotics' }));
      await until(() => buttonLike(/^(Run sponsorship check|Sponsorship check running)/), 'the check button');
    },
    leave: unmount,
    begin: clickStart(/^Run sponsorship check/),
    canStartAnother: () => !buttonLike(/^(Run sponsorship check|Sponsorship check running)/)!.disabled,
  },
  {
    name: 'Application > Sponsorship > Refresh check',
    mode: 'sponsorship-check',
    async open() {
      if (applicationOpen) {
        await openTab('Sponsorship');
      } else {
        const { ApplicationPage } = await import('@web/features/tracker/ApplicationPage');
        const rootRoute = createRootRoute();
        const page = createRoute({ getParentRoute: () => rootRoute, path: '/tracker/$n', component: ApplicationPage });
        const router = createRouter({ routeTree: rootRoute.addChildren([page]), history: createMemoryHistory({ initialEntries: ['/tracker/7'] }) });
        await mount(createElement(RouterProvider, { router }));
        applicationOpen = true;
        await openTab('Sponsorship');
      }
      await until(() => buttonLike(/^(Refresh check|Sponsorship check running)/), 'the refresh button');
    },
    // Switching to another tab unmounts the check, as the page itself stays.
    async leave() {
      await openTab('Report');
      panels = [];
    },
    begin: clickStart(/^Refresh check/),
    canStartAnother: () => !buttonLike(/^(Refresh check|Sponsorship check running)/)!.disabled,
  },
  {
    name: 'Sponsorship > Run AI policy pass',
    mode: 'immigration-policy',
    async open() {
      const { SponsorshipPage } = await import('@web/features/sponsorship/SponsorshipPage');
      const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
      const rootRoute = createRootRoute({ component: () => createElement(ConfirmProvider, null, createElement(Outlet)) });
      const sponsorship = createRoute({ getParentRoute: () => rootRoute, path: '/sponsorship', component: SponsorshipPage, validateSearch: () => ({ tab: 'overview' as const }) });
      const router = createRouter({ routeTree: rootRoute.addChildren([sponsorship]), history: createMemoryHistory({ initialEntries: ['/sponsorship'] }) });
      await mount(createElement(RouterProvider, { router }));
      await until(() => buttonLike(/^(Run AI policy pass|Policy pass running)/), 'the policy pass button');
    },
    leave: unmount,
    begin: clickStart(/^Run AI policy pass/),
    canStartAnother: () => !buttonLike(/^(Run AI policy pass|Policy pass running)/)!.disabled,
  },
  {
    name: 'Tracker > Compare selected',
    mode: 'ofertas',
    async open() {
      const { CompareSelected } = await import('@web/features/tracker/CompareSelected');
      await mount(createElement(CompareSelected, { rows: [trackerRow(1, 'Acme'), trackerRow(2, 'Globex')], onClear: () => undefined }));
    },
    leave: unmount,
    begin: clickStart(/^Compare selected/),
    canStartAnother: () => !buttonLike(/^Compare selected/)!.disabled,
  },
  {
    name: 'Discover > AI search',
    mode: 'ai-search',
    async open() {
      const { AiSearchTab } = await import('@web/features/discover/AiSearchTab');
      await mount(createElement(AiSearchTab));
    },
    leave: unmount,
    // The search starts from its panel's own form.
    async begin() {
      await act(async () => lastPanel('ai-search')!.onStarting!());
    },
    // New search lets go of the search and offers the start form for another one.
    canStartAnother: () => buttonLike(/^New search$/) !== undefined,
  },
];

const lastPanel = (mode: string) => panels.filter((p) => p.mode === mode).pop();
/** Whether the panel's reply can be sent: a disabled fieldset around it holds it back. */
const canReply = (mode: string) => host.querySelector(`[data-reply="${mode}"]`)?.closest('fieldset')?.disabled !== true;

beforeEach(() => {
  panels = [];
  applicationOpen = false;
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/tracker/7') return json(200, detail());
      if (url === '/api/pipeline') return json(200, { kind: 'ok', path: 'data/pipeline.md', rows: [], etag: 'e' });
      if (url === '/api/tracker') return json(200, { kind: 'ok', rows: [] });
      return json(404, { error: 'not stubbed' });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(async () => {
  if (root) await unmount();
  host.remove();
  vi.unstubAllGlobals();
});

describe.each(HOSTS)('$name', (h) => {
  /** The session started here and finished, as the panel reports it. */
  async function finishedSession(id: string) {
    await h.open();
    await h.begin();
    await act(async () => lastPanel(h.mode)!.onSessionId!(id));
    await act(async () => lastPanel(h.mode)!.onStatus!('done', null));
    expect(h.canStartAnother()).toBe(true);
  }
  /** The user replies in the panel: the real panel reports the turn as a start only when its host asks for it. */
  async function replyInFlight(): Promise<PanelProps> {
    const p = lastPanel(h.mode)!;
    if (p.marksTurnStarts) await act(async () => p.onStarting!());
    return p;
  }

  it('given a reply to the finished session in flight, no second session can start until the server answers', async () => {
    await finishedSession('s-1');
    const p = await replyInFlight();
    expect(h.canStartAnother()).toBe(false);
    // The server takes the turn: the session runs it, and once it ends another session can start.
    await act(async () => p.onSessionId!('s-1'));
    await act(async () => lastPanel(h.mode)!.onStatus!('running', null));
    expect(h.canStartAnother()).toBe(false);
    await act(async () => lastPanel(h.mode)!.onStatus!('done', null));
    expect(h.canStartAnother()).toBe(true);
  });

  it('given the host left and opened again while the reply is in flight, no second session can start until it reports', async () => {
    await finishedSession('s-1');
    const p = await replyInFlight();
    await h.leave();
    await h.open();
    // The re-attached session still reads as finished: its stream has not shown the new turn yet.
    // The session exists: its panel stays, re-attached.
    const back = lastPanel(h.mode)!;
    expect(back.sessionId).toBe('s-1');
    await act(async () => back.onStatus!('done', null));
    expect(h.canStartAnother()).toBe(false);
    // A second reply from here would be refused beside the first, and the refusal would let go of its start mark.
    expect(canReply(h.mode)).toBe(false);
    // The reply is refused (the left panel still reports it): the start mark is let go and the button comes back.
    await act(async () => p.onStartFailed!());
    await act(async () => lastPanel(h.mode)!.onStatus!('done', null));
    expect(h.canStartAnother()).toBe(true);
    expect(canReply(h.mode)).toBe(true);
  });
});

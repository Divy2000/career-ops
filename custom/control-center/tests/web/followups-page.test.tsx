// Follow-ups page: its paid launcher sessions survive a tab switch, a failed invite match does not leave the previous
// invite's result under the new text, and a retired application offers no pin that the cadence would ignore.
import { createElement, type ComponentType } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionMeta, FollowupCadence, FollowupCadenceEntry } from '@shared/api';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let launchers: Array<{ heading: string; rememberAs?: string }>;
vi.mock('@web/components/ModeLauncher', () => ({
  ModeLauncher: (props: { heading: string; rememberAs?: string }) => {
    launchers.push(props);
    return null;
  },
}));

const entry = (over: Partial<FollowupCadenceEntry>): FollowupCadenceEntry => ({
  num: 1, company: 'Acme Robotics', role: 'Backend Engineer', status: 'applied', score: '4.3/5', appliedDate: '2026-09-01', daysSinceApplication: 30,
  daysSinceLastFollowup: 20, followupCount: 2, urgency: 'overdue', nextFollowupDate: '2026-10-01', daysUntilNext: -9, nextOverride: null, contacts: [], followups: [], ...over,
});
const CADENCE: FollowupCadence = {
  metadata: { analysisDate: '2026-10-10', totalTracked: 2, actionable: 1, overdue: 1, urgent: 0, cold: 0, waiting: 0, retired: 1 },
  entries: [entry({}), entry({ num: 12, company: 'Globex', urgency: 'retired', nextFollowupDate: null, daysUntilNext: null })],
};
const ACTIONS: ActionMeta[] = [{ id: 'followups.inviteMatch', label: 'Match invite', cost: 'free', confirm: null, resources: [], claude: false, sync: true, params: {} }];

let host: HTMLElement;
let root: Root;
let inviteAnswer: () => Response;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  launchers = [];
  inviteAnswer = () => json(200, { result: { row: 12, company: 'Globex' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/followups') return json(200, CADENCE);
      if (url === '/api/actions') return json(200, ACTIONS);
      if (url === '/api/actions/followups.inviteMatch') return inviteAnswer();
      return json(404, { error: 'not stubbed' });
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

async function render(component: ComponentType) {
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const rootRoute = createRootRoute({ component: () => createElement(ConfirmProvider, null, createElement(Outlet)) });
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/', component });
  const tracker = createRoute({ getParentRoute: () => rootRoute, path: '/tracker/$n', component: () => null });
  const router = createRouter({ routeTree: rootRoute.addChildren([page, tracker]), history: createMemoryHistory({ initialEntries: ['/'] }) });
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(RouterProvider, { router }))));
}
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

describe('Follow-ups page', () => {
  it('both launchers remember their sessions, so a tab switch does not lose a running paid session (R13-feat-a-L1-05)', async () => {
    const { CadenceTab, RepliesTab } = await import('@web/features/followups/FollowupsPage');
    await render(() => createElement('div', null, createElement(CadenceTab), createElement(RepliesTab)));
    await until(() => launchers.length >= 2 || undefined, 'the launchers');
    const keys = new Map(launchers.map((l) => [l.heading, l.rememberAs]));
    expect(keys.get('AI drafts')).toBe('cc.followups.cadence');
    expect(keys.get('Reply watch session')).toBe('cc.followups.replies');
  });

  it('a retired application offers no +7d pin, which the cadence would ignore (R13-feat-a-X-01, SW9-web-a-02)', async () => {
    const { CadenceTab } = await import('@web/features/followups/FollowupsPage');
    await render(CadenceTab);
    await until(() => button('Pin next follow-up for Globex in 7 days'), 'the cadence table');
    expect(button('Pin next follow-up for Globex in 7 days')!.disabled).toBe(true);
    expect(button('Pin next follow-up for Acme Robotics in 7 days')!.disabled).toBe(false);
  });

  it('a failed invite match clears the previous invite\'s result (R13-feat-a-L1-08)', async () => {
    const { RepliesTab } = await import('@web/features/followups/FollowupsPage');
    await render(RepliesTab);
    const text = await until(() => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Invite text"]'), 'the invite box');
    const type = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(text, value);
        text.dispatchEvent(new Event('input', { bubbles: true }));
      });
    const match = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith('Match invite'))!;
    await type('Invite from Globex');
    await until(() => match() && !match().disabled, 'Match invite');
    await act(async () => match().click());
    await until(() => host.textContent?.includes('"company": "Globex"'), 'the first match');

    inviteAnswer = () => json(500, { error: 'invite-match.mjs exited 1' });
    await type('Invite from Initech');
    await act(async () => match().click());
    await until(() => host.textContent?.includes('Could not run followups.inviteMatch'), 'the failure');
    expect(host.textContent).not.toContain('Globex');
  });
});

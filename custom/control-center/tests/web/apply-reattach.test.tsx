// Apply: the draft session is paid, and "Fill real form" is reachable only from this page. Leaving the page and coming
// back re-attaches the row's last apply session, whose answers envelope rebuilds the form, and leaving with edited
// answers asks first (SW8-web-a-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter, type AnyRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyDocuments, SessionMeta } from '@shared/api';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PanelProps = { mode: string; sessionId?: string | null; startLabel?: string; onStarting?: () => void; onEnvelope?: (kind: string, payload: unknown, turn: number) => void; onSessionId?: (id: string) => void; onStatus?: (s: string, r: string | null) => void; onStartFailed?: () => void };
let panels: PanelProps[];
vi.mock('@web/components/SessionPanel', () => ({
  // Like the real panel: with no session it shows its start form, whose button sends POST /api/sessions (onStarting).
  SessionPanel: (props: PanelProps) => {
    panels.push(props);
    return props.sessionId ? null : createElement('button', { type: 'button', onClick: () => props.onStarting?.() }, props.startLabel ?? 'Start session');
  },
}));

let host: HTMLElement;
let root: Root;
let router: AnyRouter;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
// GET /api/apply/documents?n=12 for a row with a tailored CV (documents.ts).
const DOCS: ApplyDocuments = { pdfs: ['output/cv-acme.pdf'], covers: [], suggestedPdf: 'output/cv-acme.pdf', suggestedCover: null };
const ANSWERS = { fields: [{ id: 'name', label: 'Full name', type: 'text', required: true, value: 'Jane Smith', needsConfirmation: false }, { id: 'why', label: 'Why Acme', type: 'textarea', required: false, value: 'Robots.', needsConfirmation: true }] };

async function openApply(n: string | null = '12') {
  const { ApplyBody } = await import('@web/features/apply/ApplyPage');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const rootRoute = createRootRoute({ component: () => createElement(ConfirmProvider, null, createElement(Outlet)) });
  const apply = createRoute({ getParentRoute: () => rootRoute, path: '/apply', component: () => createElement(ApplyBody, n ? { n, company: 'Acme Robotics', postingUrl: 'https://jobs.example.com/acme/1' } : { n: null, company: null, postingUrl: '' }) });
  const elsewhere = createRoute({ getParentRoute: () => rootRoute, path: '/elsewhere', component: () => createElement('p', null, 'Elsewhere page') });
  router = createRouter({ routeTree: rootRoute.addChildren([apply, elsewhere]), history: createMemoryHistory({ initialEntries: ['/apply'] }) });
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(RouterProvider, { router }))));
  // The panel, or while another mount's start is still in flight, the note that stands in for it.
  await until(() => applyPanel() ?? (host.textContent?.includes('Starting the apply session') || undefined), 'the apply session panel');
}
const applyPanel = () => panels.filter((p) => p.mode === 'apply').pop();
const draftButton = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Draft answers');
const fillButton = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Fill real form');
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

// A session started from /apply with no tracker row: its target is the posting URL (GET /api/sessions/:id).
const URL_SESSION: SessionMeta = {
  id: 's-apply-url', claudeSessionId: '22222222-2222-4222-8222-222222222222', mode: 'apply', policyClass: 'apply', target: { type: 'url', value: 'https://boards.example.com/globex/9' }, model: null,
  status: 'done', createdAt: '2026-10-06T12:00:00.000Z', updatedAt: '2026-10-06T12:05:00.000Z', turns: [], totals: { costUsd: 0.4, tokens: 9000 }, filesChanged: [], forkedFrom: null,
  error: null, reportNum: null, lastReason: 'clean exit with output', policyVersion: 2,
};

async function draftAnswers() {
  await act(async () => applyPanel()!.onSessionId!('s-apply-12'));
  await act(async () => applyPanel()!.onStatus!('done', 'clean exit with output'));
  await act(async () => applyPanel()!.onEnvelope!('answers', ANSWERS, 1));
}

beforeEach(() => {
  panels = [];
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/sessions/engine') return json({ playwrightAvailable: true, modes: ['apply'] });
      if (url === '/api/apply/documents?n=12' || url === '/api/apply/documents') return json(DOCS);
      if (url === '/api/sessions/s-apply-url') return json({ meta: URL_SESSION, events: [] });
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

describe('Apply keeps its drafted answers across leaving the page', () => {
  it('coming back re-attaches the row\'s apply session, and its answers envelope brings back the form and Fill', async () => {
    await openApply();
    await draftAnswers();
    expect(fillButton()).toBeDefined();

    await act(async () => root.unmount());
    panels = [];
    await openApply();
    expect(applyPanel()).toMatchObject({ sessionId: 's-apply-12' });
    // The re-attached panel replays the session's envelopes to the host.
    await act(async () => applyPanel()!.onStatus!('done', 'clean exit with output'));
    await act(async () => applyPanel()!.onEnvelope!('answers', ANSWERS, 1));
    expect(host.querySelector<HTMLInputElement>('[aria-label="Drafted answers"] input')!.value).toBe('Jane Smith');
    await until(() => fillButton() && !fillButton()!.disabled && fillButton(), 'Fill real form enabled');
  });

  it('keeps one remembered session per row, so another row starts clean', async () => {
    sessionStorage.setItem('cc.apply.7', 's-apply-7');
    await openApply();
    expect(applyPanel()!.sessionId ?? null).toBeNull();
  });

  it('leaving while the draft is still starting and coming back offers no second draft, and attaches the session once it is created', async () => {
    await openApply();
    await act(async () => draftButton()!.click());
    const starting = applyPanel()!;

    // The user leaves before POST /api/sessions answers; the start goes on and reports the id afterwards.
    await act(async () => root.unmount());
    panels = [];
    await openApply();
    expect(draftButton()).toBeUndefined();
    expect(host.textContent).toContain('Starting the apply session');

    await act(async () => starting.onSessionId!('s-apply-12'));
    expect(applyPanel()).toMatchObject({ sessionId: 's-apply-12' });
  });

  it('a draft whose start fails after leaving gives Draft answers back', async () => {
    await openApply();
    await act(async () => draftButton()!.click());
    const starting = applyPanel()!;
    await act(async () => root.unmount());
    panels = [];
    await openApply();
    expect(draftButton()).toBeUndefined();

    await act(async () => starting.onStartFailed!());
    await until(() => draftButton(), 'the Draft answers button');
  });

  it('a remembered session the server no longer has is let go', async () => {
    sessionStorage.setItem('cc.apply.12', 's-deleted');
    await openApply();
    expect(applyPanel()).toMatchObject({ sessionId: 's-deleted' });
    await act(async () => applyPanel()!.onStatus!('gone', null));
    expect(sessionStorage.getItem('cc.apply.12')).toBeNull();
    expect(applyPanel()!.sessionId ?? null).toBeNull();
  });

  it('on /apply with no row, the re-attached session brings back the posting URL it was drafted for', async () => {
    vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
    sessionStorage.setItem('cc.apply.url', 's-apply-url');
    await openApply(null);
    expect(applyPanel()).toMatchObject({ sessionId: 's-apply-url' });
    await until(() => host.querySelector<HTMLInputElement>('[aria-label="Posting URL"]')!.value === 'https://boards.example.com/globex/9', 'the posting URL');
  });

  it('leaving with edited answers asks first, and Cancel keeps the edits', async () => {
    await openApply();
    await draftAnswers();
    const input = host.querySelector<HTMLInputElement>('[aria-label="Drafted answers"] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Jane Q. Smith');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => void router.navigate({ to: '/elsewhere' }));
    expect((await until(dialog, 'the discard question')).textContent).toContain('the edited answers has unsaved changes');
    await act(async () => [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click());
    await until(() => !dialog(), 'the question to close');
    expect(router.state.location.pathname).toBe('/apply');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Drafted answers"] input')!.value).toBe('Jane Q. Smith');
  });

  it('leaving with the answers as drafted does not ask: the session keeps them', async () => {
    await openApply();
    await draftAnswers();
    await act(async () => void router.navigate({ to: '/elsewhere' }));
    await until(() => host.textContent?.includes('Elsewhere page'), 'the other page');
    expect(dialog()).toBeNull();
  });
});

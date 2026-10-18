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

type PanelProps = { mode: string; sessionId?: string | null; startLabel?: string; marksTurnStarts?: boolean; onStarting?: () => void; onEnvelope?: (kind: string, payload: unknown, turn: number) => void; onSessionId?: (id: string) => void; onStatus?: (s: string, r: string | null) => void; onStartFailed?: () => void };
let panels: PanelProps[];
vi.mock('@web/components/SessionPanel', () => ({
  // Like the real panel: with no session it shows its start form, whose button sends POST /api/sessions (onStarting).
  SessionPanel: (props: PanelProps) => {
    panels.push(props);
    // With a session it shows its reply form, whose Send carries the turn.
    return props.sessionId ? createElement('button', { type: 'button' }, 'Send') : createElement('button', { type: 'button', onClick: () => props.onStarting?.() }, props.startLabel ?? 'Start session');
  },
}));

let host: HTMLElement;
// GET /api/sessions/s-pdf-12, the tailored CV session; its status is what a test sets.
let pdfStatus: string;
let docs: ApplyDocuments;
/** While set, POST /api/sessions waits for it, so a test can leave the page while the start is in flight. */
let startGate: Promise<void> | null;
/** While set, POST /api/sessions/s-apply-12/turns (Fill) waits for it, so a test can act while the turn is in flight. */
let turnGate: Promise<void> | null;
/** Set to refuse the Fill turn as the server does when the draft runs a turn started elsewhere. */
let turnRefused: boolean;
/** The tracker.setStatus actions the page sent. */
let statusPosts: Array<Record<string, unknown>>;
/** A tracker.setStatus refusal the server answers instead of applying it, or null to apply it. */
let statusRefusal: { status: number; body: unknown } | null;
let root: Root;
let router: AnyRouter;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
// GET /api/apply/documents?n=12 for a row with a tailored CV (documents.ts).
const DOCS: ApplyDocuments = { pdfs: ['output/cv-acme.pdf'], covers: [], suggestedPdf: 'output/cv-acme.pdf', suggestedCover: null };
const ANSWERS = { fields: [{ id: 'name', label: 'Full name', type: 'text', required: true, value: 'Jane Smith', needsConfirmation: false }, { id: 'why', label: 'Why Acme', type: 'textarea', required: false, value: 'Robots.', needsConfirmation: true }] };

// The row the page shows under #12, as the tracker read it.
const ROW_12 = { company: 'Acme Robotics', role: 'Robotics Engineer', report: 31 };
const APPLIED_12 = { row: 12, state: 'Applied', expectCompany: 'Acme Robotics', expectRole: 'Robotics Engineer', expectReport: 31 };

async function openApply(n: string | null = '12', status?: string, identity: typeof ROW_12 | null = ROW_12) {
  const { ApplyBody } = await import('@web/features/apply/ApplyPage');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const rootRoute = createRootRoute({ component: () => createElement(ConfirmProvider, null, createElement(Outlet)) });
  const apply = createRoute({ getParentRoute: () => rootRoute, path: '/apply', component: () => createElement(ApplyBody, n ? { n, company: (identity ?? ROW_12).company, postingUrl: 'https://jobs.example.com/acme/1', status, ...(identity ? { identity } : {}) } : { n: null, company: null, postingUrl: '' }) });
  const elsewhere = createRoute({ getParentRoute: () => rootRoute, path: '/elsewhere', component: () => createElement('p', null, 'Elsewhere page') });
  const session = createRoute({ getParentRoute: () => rootRoute, path: '/sessions/$id', component: () => createElement('p', null, 'Session page') });
  router = createRouter({ routeTree: rootRoute.addChildren([apply, elsewhere, session]), history: createMemoryHistory({ initialEntries: ['/apply'] }) });
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(RouterProvider, { router }))));
  // The panel, or while another mount's start is still in flight, the note that stands in for it.
  await until(() => applyPanel() ?? (host.textContent?.includes('Starting the apply session') || undefined), 'the apply session panel');
}
const applyPanel = () => panels.filter((p) => p.mode === 'apply').pop();
const draftButton = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Draft answers');
const sendButton = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Send');
/** Whether the panel's reply can be sent: a disabled fieldset around it holds it back. */
const canReply = () => sendButton()?.closest('fieldset')?.disabled !== true;
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
  docs = DOCS;
  pdfStatus = 'running';
  startGate = null;
  turnGate = null;
  turnRefused = false;
  statusPosts = [];
  statusRefusal = null;
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/sessions/engine') return json({ playwrightAvailable: true, modes: ['apply'] });
      if (url === '/api/apply/documents?n=12' || url === '/api/apply/documents') return json(docs);
      if (url === '/api/sessions' && init?.method === 'POST') {
        if (startGate) await startGate;
        return json({ ...URL_SESSION, id: 's-pdf-12', mode: 'pdf', status: 'queued', target: { type: 'app', value: '12' } });
      }
      if (url === '/api/sessions' && init?.method !== 'POST') return json([]);
      if (url === '/api/sessions/s-apply-12/turns' && init?.method === 'POST') {
        if (turnGate) await turnGate;
        if (turnRefused) return new Response(JSON.stringify({ error: 'session s-apply-12 is running' }), { status: 409, headers: { 'content-type': 'application/json' } });
        return json({ ...URL_SESSION, id: 's-apply-12', status: 'running', target: { type: 'app', value: '12' } });
      }
      if (url === '/api/sessions/s-pdf-12') return json({ meta: { ...URL_SESSION, id: 's-pdf-12', mode: 'pdf', status: pdfStatus, target: { type: 'app', value: '12' } }, events: [{ seq: 1, event: { type: 'status', status: pdfStatus, reason: null } }] });
      if (url === '/api/sessions/s-apply-url') return json({ meta: URL_SESSION, events: [] });
      if (url === '/api/actions/tracker.setStatus' && init?.method === 'POST') {
        statusPosts.push((JSON.parse(String(init.body)) as { params: Record<string, unknown> }).params);
        if (statusRefusal) return new Response(JSON.stringify(statusRefusal.body), { status: statusRefusal.status, headers: { 'content-type': 'application/json' } });
        return json({ result: 'updated' });
      }
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

  it('a draft started here and deleted elsewhere drops its answers and Fill, and offers Draft answers again', async () => {
    await openApply();
    await act(async () => draftButton()!.click());
    await draftAnswers();
    expect(fillButton()).toBeDefined();
    // Deleted on the Sessions page in another tab: the panel's stream (or a reply's 404) reports it gone.
    await act(async () => applyPanel()!.onStatus!('gone', null));
    await until(() => draftButton(), 'the Draft answers button');
    expect(fillButton()).toBeUndefined();
    expect(host.querySelector('[aria-label="Drafted answers"]')).toBeNull();
    expect(applyPanel()!.sessionId ?? null).toBeNull();
    expect(sessionStorage.getItem('cc.apply.12')).toBeNull();
  });

  it('a draft with edited answers deleted elsewhere drops them without asking, so the next draft cannot fill them', async () => {
    await openApply();
    await act(async () => draftButton()!.click());
    await draftAnswers();
    const input = host.querySelector<HTMLInputElement>('[aria-label="Drafted answers"] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Jane Q. Smith');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => applyPanel()!.onStatus!('gone', null));
    await until(() => draftButton(), 'the Draft answers button');
    // The deleted session's answers cannot be kept: no discard question that could keep them on Cancel.
    expect(dialog()).toBeNull();
    expect(host.querySelector('[aria-label="Drafted answers"]')).toBeNull();

    // The next draft's id arrives before its answers envelope: Fill is not offered with the old session's edits.
    await act(async () => draftButton()!.click());
    await act(async () => applyPanel()!.onSessionId!('s-apply-12b'));
    expect(fillButton()).toBeUndefined();
  });

  it('on a tracker row, a typed apply link comes back with the re-attached draft, so prefill uses it', async () => {
    await openApply();
    const input = host.querySelector<HTMLInputElement>('[aria-label="Posting URL"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://careers.acme.example/apply/1');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => draftButton()!.click());
    await act(async () => applyPanel()!.onSessionId!('s-apply-12'));

    await act(async () => root.unmount());
    panels = [];
    await openApply();
    expect(applyPanel()).toMatchObject({ sessionId: 's-apply-12' });
    expect(host.querySelector<HTMLInputElement>('[aria-label="Posting URL"]')!.value).toBe('https://careers.acme.example/apply/1');
  });

  it('Given a CV PDF and cover letter picked for a draft, When the page comes back, Then they are still picked and Fill attaches them (R28-feat-a-L2-01)', async () => {
    docs = { pdfs: ['output/cv-acme.pdf', 'output/cv-acme-short.pdf'], covers: ['output/cover-acme.md'], suggestedPdf: 'output/cv-acme.pdf', suggestedCover: null };
    await openApply();
    const pick = async (label: string, value: string) => {
      await until(() => host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`), label);
      const select = host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
      await act(async () => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };
    await pick('CV PDF to attach', 'output/cv-acme-short.pdf');
    await pick('Cover letter text', 'output/cover-acme.md');
    await act(async () => draftButton()!.click());
    await draftAnswers();

    await act(async () => root.unmount());
    panels = [];
    await openApply();
    expect(applyPanel()).toMatchObject({ sessionId: 's-apply-12' });
    await until(() => host.querySelector<HTMLSelectElement>('[aria-label="Cover letter text"]'), 'the cover letter select');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="CV PDF to attach"]')!.value).toBe('output/cv-acme-short.pdf');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Cover letter text"]')!.value).toBe('output/cover-acme.md');

    await act(async () => applyPanel()!.onStatus!('done', 'clean exit with output'));
    await act(async () => applyPanel()!.onEnvelope!('answers', ANSWERS, 1));
    await until(() => fillButton() && !fillButton()!.disabled && fillButton(), 'Fill real form enabled');
    await act(async () => fillButton()!.click());
    const call = vi.mocked(fetch).mock.calls.find(([u, init]) => u === '/api/sessions/s-apply-12/turns' && init?.method === 'POST');
    expect(String(call![1]!.body)).toContain('attach the CV PDF output/cv-acme-short.pdf and use the cover letter text in output/cover-acme.md');
  });

  it('Given a draft started before any CV PDF existed, When the tailored CV arrives and the page comes back, Then it is preselected (R28-feat-a-L2-01 review)', async () => {
    docs = { pdfs: [], covers: [], suggestedPdf: null, suggestedCover: null };
    await openApply();
    await until(() => host.querySelector('[aria-label="CV PDF to attach"]'), 'the CV PDF select');
    await act(async () => draftButton()!.click());
    await act(async () => applyPanel()!.onSessionId!('s-apply-12'));

    await act(async () => root.unmount());
    panels = [];
    docs = DOCS;
    await openApply();
    await until(() => host.querySelector<HTMLSelectElement>('[aria-label="CV PDF to attach"]')?.value === 'output/cv-acme.pdf', 'the tailored CV preselected');
  });

  it('Given the CV PDF a draft named was removed from output/, When the page comes back, Then Fill does not attach the missing file (R28-feat-a-L2-01 review)', async () => {
    sessionStorage.setItem('cc.apply.12', 's-apply-12');
    sessionStorage.setItem('cc.apply.docs.s-apply-12', JSON.stringify({ pdf: 'output/cv-gone.pdf', cover: 'output/cover-gone.md' }));
    await openApply();
    await until(() => host.querySelector<HTMLSelectElement>('[aria-label="CV PDF to attach"]'), 'the CV PDF select');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="CV PDF to attach"]')!.value).toBe('output/cv-acme.pdf');
    await act(async () => applyPanel()!.onStatus!('done', 'clean exit with output'));
    await act(async () => applyPanel()!.onEnvelope!('answers', ANSWERS, 1));
    await until(() => fillButton() && !fillButton()!.disabled && fillButton(), 'Fill real form enabled');
    await act(async () => fillButton()!.click());
    const call = vi.mocked(fetch).mock.calls.find(([u, init]) => u === '/api/sessions/s-apply-12/turns' && init?.method === 'POST');
    expect(String(call![1]!.body)).not.toContain('gone');
  });

  it('Given None picked for the cover letter and no PDF for a draft, When the page comes back, Then the row\'s suggestions do not replace those choices (R28-feat-a-L2-01 review)', async () => {
    docs = { pdfs: ['output/cv-acme.pdf'], covers: ['output/cover-acme.md'], suggestedPdf: 'output/cv-acme.pdf', suggestedCover: 'output/cover-acme.md' };
    await openApply();
    for (const label of ['CV PDF to attach', 'Cover letter text']) {
      await until(() => host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)?.value, label);
      const select = host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
      await act(async () => {
        select.value = '';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    await act(async () => draftButton()!.click());
    await act(async () => applyPanel()!.onSessionId!('s-apply-12'));

    await act(async () => root.unmount());
    panels = [];
    await openApply();
    await until(() => host.querySelector<HTMLSelectElement>('[aria-label="Cover letter text"]'), 'the cover letter select');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="CV PDF to attach"]')!.value).toBe('');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Cover letter text"]')!.value).toBe('');
  });

  it('Given a different CV PDF picked after the draft started, When the page comes back, Then the latest pick is kept (R28-feat-a-L2-01 review)', async () => {
    docs = { pdfs: ['output/cv-acme.pdf', 'output/cv-acme-short.pdf'], covers: [], suggestedPdf: 'output/cv-acme.pdf', suggestedCover: null };
    await openApply();
    await act(async () => draftButton()!.click());
    await draftAnswers();
    const select = await until(() => host.querySelector<HTMLSelectElement>('[aria-label="CV PDF to attach"]'), 'the CV PDF select');
    await act(async () => {
      select.value = 'output/cv-acme-short.pdf';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => root.unmount());
    panels = [];
    await openApply();
    await until(() => host.querySelector<HTMLSelectElement>('[aria-label="CV PDF to attach"]')?.value === 'output/cv-acme-short.pdf', 'the latest pick');
  });

  it('Given a re-attached draft that named its CV PDF and None for the cover letter, When a reply forks it, Then the fork keeps those documents (R29-feat-a-L1-01)', async () => {
    docs = { pdfs: ['output/cv-acme.pdf', 'output/cv-acme-short.pdf'], covers: ['output/cover-acme.md'], suggestedPdf: 'output/cv-acme.pdf', suggestedCover: 'output/cover-acme.md' };
    sessionStorage.setItem('cc.apply.12', 's-apply-12');
    sessionStorage.setItem('cc.apply.docs.s-apply-12', JSON.stringify({ pdf: 'output/cv-acme-short.pdf', cover: '' }));
    await openApply();
    await until(() => host.querySelector<HTMLSelectElement>('[aria-label="Cover letter text"]'), 'the cover letter select');
    await act(async () => applyPanel()!.onSessionId!('s-apply-fork'));

    expect(applyPanel()).toMatchObject({ sessionId: 's-apply-fork' });
    expect(JSON.parse(sessionStorage.getItem('cc.apply.docs.s-apply-fork')!)).toEqual({ pdf: 'output/cv-acme-short.pdf', cover: '' });
    expect(host.querySelector<HTMLSelectElement>('[aria-label="CV PDF to attach"]')!.value).toBe('output/cv-acme-short.pdf');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Cover letter text"]')!.value).toBe('');
  });

  it('Given a re-attached draft started from a typed apply link, When a reply forks it, Then the fork keeps that link and prefill uses it (R30-feat-a-X-01)', async () => {
    sessionStorage.setItem('cc.apply.12', 's-apply-12');
    sessionStorage.setItem('cc.apply.typedUrl.s-apply-12', 'https://boards.greenhouse.io/acme/jobs/123');
    await openApply();
    expect(host.querySelector<HTMLInputElement>('[aria-label="Posting URL"]')!.value).toBe('https://boards.greenhouse.io/acme/jobs/123');
    await act(async () => applyPanel()!.onSessionId!('s-apply-fork'));

    expect(applyPanel()).toMatchObject({ sessionId: 's-apply-fork' });
    expect(sessionStorage.getItem('cc.apply.typedUrl.s-apply-fork')).toBe('https://boards.greenhouse.io/acme/jobs/123');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Posting URL"]')!.value).toBe('https://boards.greenhouse.io/acme/jobs/123');
  });

  it('Given a CV PDF picked while the draft is still starting, When the page comes back, Then that pick is kept (R29-feat-a-L1-02)', async () => {
    docs = { pdfs: ['output/cv-acme.pdf', 'output/cv-acme-short.pdf'], covers: [], suggestedPdf: 'output/cv-acme.pdf', suggestedCover: null };
    await openApply();
    const select = await until(() => host.querySelector<HTMLSelectElement>('[aria-label="CV PDF to attach"]'), 'the CV PDF select');
    await act(async () => draftButton()!.click());
    const starting = applyPanel()!;
    await act(async () => {
      select.value = 'output/cv-acme-short.pdf';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // The start answers with the id through the callback of the click's render.
    await act(async () => starting.onSessionId!('s-apply-12'));

    await act(async () => root.unmount());
    panels = [];
    await openApply();
    await until(() => host.querySelector<HTMLSelectElement>('[aria-label="CV PDF to attach"]')?.value === 'output/cv-acme-short.pdf', 'the pick made mid-start');
  });

  it('Given the documents listing still loading, When Fill is clicked on a re-attached draft, Then it attaches the draft\'s CV PDF (R28-feat-a-L2-01 review)', async () => {
    let releaseDocs!: () => void;
    const docsGate = new Promise<void>((r) => (releaseDocs = r));
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (url === '/api/apply/documents?n=12') await docsGate;
      return base(url, init);
    });
    sessionStorage.setItem('cc.apply.12', 's-apply-12');
    sessionStorage.setItem('cc.apply.docs.s-apply-12', JSON.stringify({ pdf: 'output/cv-b.pdf', cover: null }));
    await openApply();
    await act(async () => applyPanel()!.onStatus!('done', 'clean exit with output'));
    await act(async () => applyPanel()!.onEnvelope!('answers', ANSWERS, 1));
    await until(() => fillButton() && !fillButton()!.disabled && fillButton(), 'Fill real form enabled');
    await act(async () => fillButton()!.click());
    releaseDocs();
    const call = vi.mocked(fetch).mock.calls.find(([u, init]) => u === '/api/sessions/s-apply-12/turns' && init?.method === 'POST');
    expect(String(call![1]!.body)).toContain('attach the CV PDF output/cv-b.pdf');
  });

  it('Given a draft that named no CV PDF, When a reply is sent to it and a newer CV arrives, Then the newer one is preselected (R28-feat-a-L2-01 review)', async () => {
    sessionStorage.setItem('cc.apply.12', 's-apply-12');
    sessionStorage.setItem('cc.apply.docs.s-apply-12', JSON.stringify({ pdf: null, cover: null }));
    await openApply();
    await until(() => host.querySelector<HTMLSelectElement>('[aria-label="CV PDF to attach"]')?.value === 'output/cv-acme.pdf', 'the suggested CV');
    // A reply sent from the panel reports the session it runs in, the same draft.
    await act(async () => applyPanel()!.onStarting!());
    await act(async () => applyPanel()!.onSessionId!('s-apply-12'));

    await act(async () => root.unmount());
    panels = [];
    docs = { pdfs: ['output/cv-acme.pdf', 'output/cv-acme-v2.pdf'], covers: [], suggestedPdf: 'output/cv-acme-v2.pdf', suggestedCover: null };
    await openApply();
    await until(() => host.querySelector<HTMLSelectElement>('[aria-label="CV PDF to attach"]')?.value === 'output/cv-acme-v2.pdf', 'the newer CV preselected');
  });

  it('Given a draft that named no CV PDF, When only a cover letter is picked and a newer CV arrives, Then the newer one is preselected (R28-feat-a-L2-01 review)', async () => {
    sessionStorage.setItem('cc.apply.12', 's-apply-12');
    sessionStorage.setItem('cc.apply.docs.s-apply-12', JSON.stringify({ pdf: null, cover: null }));
    docs = { pdfs: ['output/cv-acme.pdf'], covers: ['output/cover-acme.md'], suggestedPdf: 'output/cv-acme.pdf', suggestedCover: null };
    await openApply();
    const select = await until(() => host.querySelector<HTMLSelectElement>('[aria-label="Cover letter text"]'), 'the cover letter select');
    await act(async () => {
      select.value = 'output/cover-acme.md';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => root.unmount());
    panels = [];
    docs = { pdfs: ['output/cv-acme.pdf', 'output/cv-acme-v2.pdf'], covers: ['output/cover-acme.md'], suggestedPdf: 'output/cv-acme-v2.pdf', suggestedCover: null };
    await openApply();
    await until(() => host.querySelector<HTMLSelectElement>('[aria-label="CV PDF to attach"]')?.value === 'output/cv-acme-v2.pdf', 'the newer CV preselected');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Cover letter text"]')!.value).toBe('output/cover-acme.md');
  });

  it('Given a draft started with the suggested CV PDF untouched, When a newer tailored CV becomes the suggestion, Then the newer one is preselected (R28-fa-rev-01)', async () => {
    docs = { pdfs: ['output/cv-old.pdf'], covers: ['output/cover-old.md'], suggestedPdf: 'output/cv-old.pdf', suggestedCover: 'output/cover-old.md' };
    await openApply();
    await until(() => host.querySelector<HTMLSelectElement>('[aria-label="CV PDF to attach"]')?.value === 'output/cv-old.pdf', 'the suggested CV preselected');
    await act(async () => draftButton()!.click());
    await act(async () => applyPanel()!.onSessionId!('s-apply-12'));

    await act(async () => root.unmount());
    panels = [];
    docs = { pdfs: ['output/cv-old.pdf', 'output/cv-new.pdf'], covers: ['output/cover-old.md', 'output/cover-new.md'], suggestedPdf: 'output/cv-new.pdf', suggestedCover: 'output/cover-new.md' };
    await openApply();
    await until(() => host.querySelector<HTMLSelectElement>('[aria-label="CV PDF to attach"]')?.value === 'output/cv-new.pdf', 'the newer CV preselected');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Cover letter text"]')!.value).toBe('output/cover-new.md');
  });

  it('Given a draft deleted elsewhere, When it reports gone, Then its kept documents are let go too (R28-feat-a-L2-01 review)', async () => {
    sessionStorage.setItem('cc.apply.12', 's-apply-12');
    sessionStorage.setItem('cc.apply.docs.s-apply-12', JSON.stringify({ pdf: 'output/cv-acme.pdf', cover: null }));
    await openApply();
    await act(async () => applyPanel()!.onStatus!('gone', null));
    expect(sessionStorage.getItem('cc.apply.docs.s-apply-12')).toBeNull();
  });

  it('Given New draft after picking documents, When the next draft starts, Then the earlier draft\'s picks are let go with it (R28-feat-a-L2-01)', async () => {
    sessionStorage.setItem('cc.apply.12', 's-apply-12');
    sessionStorage.setItem('cc.apply.docs.s-apply-12', JSON.stringify({ pdf: 'output/cv-old.pdf', cover: '' }));
    await openApply();
    await act(async () => applyPanel()!.onStatus!('done', 'clean exit with output'));
    await until(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'New draft'), 'New draft');
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'New draft')!.click());
    expect(sessionStorage.getItem('cc.apply.docs.s-apply-12')).toBeNull();
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

describe('Apply starts over and follows the sessions it started', () => {
  const urlInput = () => host.querySelector<HTMLInputElement>('[aria-label="Posting URL"]')!;
  const newDraft = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'New draft');
  const generate = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith('Generate CV PDF'));
  beforeEach(() => vi.stubGlobal('EventSource', class { addEventListener() {} close() {} }));

  it('on /apply with no row, New draft lets go of the finished draft and offers a fresh form for another posting', async () => {
    sessionStorage.setItem('cc.apply.url', 's-apply-url');
    await openApply(null);
    await act(async () => applyPanel()!.onStatus!('done', 'clean exit with output'));
    await until(() => urlInput().value === 'https://boards.example.com/globex/9', 'the posting URL');
    expect(urlInput().disabled).toBe(true);

    await act(async () => (await until(newDraft, 'the New draft button')).click());
    await until(() => draftButton(), 'the Draft answers button');
    expect(applyPanel()!.sessionId ?? null).toBeNull();
    expect(urlInput().disabled).toBe(false);
    expect(urlInput().value).toBe('');
    expect(sessionStorage.getItem('cc.apply.url')).toBeNull();
  });

  it('New draft with edited answers asks first, and Cancel keeps the draft attached', async () => {
    await openApply();
    await draftAnswers();
    const input = host.querySelector<HTMLInputElement>('[aria-label="Drafted answers"] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Jane Q. Smith');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => newDraft()!.click());
    await until(dialog, 'the discard question');
    await act(async () => [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click());
    await until(() => !dialog(), 'the question to close');
    expect(applyPanel()).toMatchObject({ sessionId: 's-apply-12' });
    expect(sessionStorage.getItem('cc.apply.12')).toBe('s-apply-12');
  });

  it('a draft still running offers no New draft, so it cannot be dropped mid-turn', async () => {
    await openApply();
    await act(async () => applyPanel()!.onSessionId!('s-apply-12'));
    await act(async () => applyPanel()!.onStatus!('running', null));
    expect(newDraft()).toBeUndefined();
  });

  // A reply in the panel starts a paid turn, but the session reads as finished until its stream shows the turn: New
  // draft would let go of it and Draft answers start a second apply session filling the same form beside it.
  /** The user replies in the panel: the real panel reports the turn as a start only when its host asks for it. */
  async function replyInFlight(): Promise<PanelProps> {
    const p = applyPanel()!;
    if (p.marksTurnStarts) await act(async () => p.onStarting!());
    return p;
  }

  it('given a reply to the finished draft in flight, New draft is not offered until its turn ends', async () => {
    await openApply();
    await draftAnswers();
    expect(newDraft()).toBeDefined();
    const p = await replyInFlight();
    expect(newDraft()).toBeUndefined();
    await act(async () => p.onSessionId!('s-apply-12'));
    await act(async () => applyPanel()!.onStatus!('running', null));
    expect(newDraft()).toBeUndefined();
    await act(async () => applyPanel()!.onStatus!('done', 'clean exit with output'));
    expect(newDraft()).toBeDefined();
  });

  it('given the page left and opened again while a reply is in flight, neither New draft nor Draft answers is offered until it reports', async () => {
    await openApply();
    await draftAnswers();
    const p = await replyInFlight();
    await act(async () => root.unmount());
    panels = [];
    await openApply();
    // The re-attached draft still reads as finished: its stream has not shown the new turn yet.
    // The draft exists: its panel stays, re-attached, rather than a note that the session is being created.
    const back = applyPanel()!;
    expect(back.sessionId).toBe('s-apply-12');
    expect(host.textContent).not.toContain('Starting the apply session');
    await act(async () => back.onStatus!('done', 'clean exit with output'));
    expect(newDraft()).toBeUndefined();
    expect(draftButton()).toBeUndefined();
    expect(canReply()).toBe(false);
    // The left panel reports the turn: the draft is attached again and runs it.
    await act(async () => p.onSessionId!('s-apply-12'));
    await until(() => applyPanel()?.sessionId === 's-apply-12' && applyPanel(), 'the draft attached again');
    await act(async () => applyPanel()!.onStatus!('done', 'clean exit with output'));
    expect(newDraft()).toBeDefined();
  });

  it('given Fill refused because the draft is running a turn started elsewhere meanwhile, New draft stays off while it runs', async () => {
    let release!: () => void;
    turnGate = new Promise<void>((r) => (release = r));
    turnRefused = true;
    await openApply();
    await draftAnswers();
    await until(() => fillButton() && !fillButton()!.disabled && fillButton(), 'Fill real form enabled');
    await act(async () => fillButton()!.click());
    await act(async () => applyPanel()!.onStatus!('running', null));
    await act(async () => release());
    await until(() => host.textContent?.includes('Could not send the fill turn'), 'the refusal');
    expect(sessionStorage.getItem('cc.apply.12:starting')).toBeNull();
    expect(newDraft()).toBeUndefined();
    await act(async () => applyPanel()!.onStatus!('done', 'clean exit with output'));
    expect(newDraft()).toBeDefined();
  });

  it('given Fill in flight, New draft is not offered, here or after leaving and coming back, until the server answers', async () => {
    let release!: () => void;
    turnGate = new Promise<void>((r) => (release = r));
    await openApply();
    await draftAnswers();
    await until(() => fillButton() && !fillButton()!.disabled && fillButton(), 'Fill real form enabled');
    await act(async () => fillButton()!.click());
    expect(newDraft()).toBeUndefined();
    await act(async () => root.unmount());
    panels = [];
    await openApply();
    // The draft exists: its panel stays, re-attached, rather than a note that the session is being created.
    const back = applyPanel()!;
    expect(back.sessionId).toBe('s-apply-12');
    expect(host.textContent).not.toContain('Starting the apply session');
    await act(async () => back.onStatus!('done', 'clean exit with output'));
    await act(async () => back.onEnvelope!('answers', ANSWERS, 1));
    expect(newDraft()).toBeUndefined();
    expect(draftButton()).toBeUndefined();
    // A second Fill or reply from here would be refused beside the first, and the refusal would let go of its mark.
    expect(fillButton()!.disabled).toBe(true);
    expect(canReply()).toBe(false);
    await act(async () => release());
    await until(() => applyPanel()?.sessionId === 's-apply-12' && applyPanel(), 'the draft attached again');
    expect(canReply()).toBe(true);
    await act(async () => applyPanel()!.onStatus!('running', null));
    expect(newDraft()).toBeUndefined();
    await act(async () => applyPanel()!.onStatus!('done', 'clean exit with output'));
    expect(newDraft()).toBeDefined();
  });

  it('on /apply with no row, a draft attached after leaving mid-start brings back its posting URL', async () => {
    await openApply(null);
    await act(async () => draftButton()!.click());
    const starting = applyPanel()!;
    await act(async () => root.unmount());
    panels = [];
    await openApply(null);
    expect(host.textContent).toContain('Starting the apply session');

    await act(async () => starting.onSessionId!('s-apply-url'));
    await until(() => urlInput().value === 'https://boards.example.com/globex/9', 'the posting URL');
  });

  it('Generate CV PDF stays off while the tailored CV session it started runs, after leaving and coming back', async () => {
    docs = { pdfs: [], covers: [], suggestedPdf: null, suggestedCover: null };
    await openApply();
    await act(async () => (await until(generate, 'the Generate CV PDF button')).click());
    await until(() => router.state.location.pathname === '/sessions/s-pdf-12', 'the session page');

    await act(async () => root.unmount());
    panels = [];
    await openApply();
    await until(() => host.querySelector('a[href="/sessions/s-pdf-12"]'), 'the link to the running session');
    expect(generate()!.disabled).toBe(true);
  });

  // A reindex can move another application under the number before the click lands: both paid starts name the one shown,
  // so the server refuses them for any other (ApplyPage.invariants.md, 5; R35-feat-a-L2-01).
  it('Generate CV PDF names the application shown under the row, so the server can refuse another one', async () => {
    docs = { pdfs: [], covers: [], suggestedPdf: null, suggestedCover: null };
    const starts: unknown[] = [];
    const inner = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (url === '/api/sessions' && init?.method === 'POST') starts.push(JSON.parse(String(init.body)));
      return inner(url, init);
    });
    await openApply();
    await act(async () => (await until(generate, 'the Generate CV PDF button')).click());
    await until(() => starts.length === 1 || undefined, 'the tailored CV start');
    expect(starts[0]).toMatchObject({ mode: 'pdf', target: { type: 'app', value: '12', expect: ROW_12 } });
  });

  it('Draft answers names the application shown under the row in the target it starts on', async () => {
    await openApply();
    expect((applyPanel() as PanelProps & { target?: unknown }).target).toEqual({ type: 'app', value: '12', expect: ROW_12 });
  });

  it('on a row whose application is not known yet, Draft answers still starts on the row and names no application', async () => {
    await openApply('12', undefined, null);
    expect((applyPanel() as PanelProps & { target?: unknown }).target).toEqual({ type: 'app', value: '12' });
  });

  it('Generate CV PDF clicked just before leaving does not pull the user onto the session page', async () => {
    docs = { pdfs: [], covers: [], suggestedPdf: null, suggestedCover: null };
    let release!: () => void;
    startGate = new Promise((r) => (release = r));
    await openApply();
    await act(async () => (await until(generate, 'the Generate CV PDF button')).click());
    await act(async () => void router.navigate({ to: '/elsewhere' }));
    await until(() => host.textContent?.includes('Elsewhere page'), 'the other page');
    await act(async () => release());
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(router.state.location.pathname).toBe('/elsewhere');
    // The start is still remembered, so the row's Apply page links it.
    expect(sessionStorage.getItem('cc.pdf.12')).toBe('s-pdf-12');
  });

  it('Generate CV PDF stays off while the tailored CV session waits for the user\'s reply', async () => {
    docs = { pdfs: [], covers: [], suggestedPdf: null, suggestedCover: null };
    pdfStatus = 'awaiting_user';
    sessionStorage.setItem('cc.pdf.12', 's-pdf-12');
    await openApply();
    await until(() => host.querySelector('a[href="/sessions/s-pdf-12"]'), 'the link to the waiting session');
    expect(generate()!.disabled).toBe(true);
  });

  it('Generate CV PDF stays off while a pdf session started from the row\'s Documents tab runs (R18-feat-a-L1-02)', async () => {
    docs = { pdfs: [], covers: [], suggestedPdf: null, suggestedCover: null };
    const inner = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (input === '/api/sessions' && init?.method !== 'POST') {
        return json([{ ...URL_SESSION, id: 's-pdf-docs', mode: 'pdf', status: 'running', target: { type: 'app', value: '12' } }]);
      }
      return inner(input, init);
    });
    await openApply();
    await until(() => host.querySelector('a[href="/sessions/s-pdf-docs"]'), 'the link to the running Documents tab session');
    expect(generate()!.disabled).toBe(true);
  });

  it('Generate CV PDF stays off while the sessions list has not confirmed there is no live pdf session (R18 review)', async () => {
    docs = { pdfs: [], covers: [], suggestedPdf: null, suggestedCover: null };
    const inner = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (input === '/api/sessions' && init?.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'internal error' }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return inner(input, init);
    });
    await openApply();
    const g = await until(() => generate(), 'the Generate CV PDF button');
    expect(g!.disabled).toBe(true);
  });

  it('Given another mount is starting the row\'s CV while an earlier one finished, Then the page says it is starting and links no finished session', async () => {
    docs = { pdfs: [], covers: [], suggestedPdf: null, suggestedCover: null };
    pdfStatus = 'done';
    sessionStorage.setItem('cc.pdf.12', 's-pdf-12');
    sessionStorage.setItem('cc.pdf.12:starting', String(Date.now()));
    await openApply();
    await until(generate, 'the Generate CV PDF button');
    // The stream has answered for the earlier session, so the page knows it finished.
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(host.querySelector('a[href="/sessions/s-pdf-12"]')).toBeNull();
    expect(host.textContent).toContain('The tailored CV session is starting.');
    expect(generate()!.disabled).toBe(true);
  });

  it('Given an earlier CV session finished, When Generate CV PDF starts another, Then the page says it is starting and links no finished session', async () => {
    docs = { pdfs: [], covers: [], suggestedPdf: null, suggestedCover: null };
    pdfStatus = 'done';
    sessionStorage.setItem('cc.pdf.12', 's-pdf-12');
    let release!: () => void;
    startGate = new Promise<void>((r) => (release = r));
    await openApply();
    await until(() => generate() && !generate()!.disabled && generate(), 'Generate CV PDF on');
    await act(async () => generate()!.click());
    expect(host.querySelector('a[href="/sessions/s-pdf-12"]')).toBeNull();
    expect(host.textContent).toContain('The tailored CV session is starting.');
    expect(generate()!.disabled).toBe(true);
    await act(async () => release());
  });

  it('Generate CV PDF comes back once the tailored CV session ended', async () => {
    docs = { pdfs: [], covers: [], suggestedPdf: null, suggestedCover: null };
    pdfStatus = 'error';
    sessionStorage.setItem('cc.pdf.12', 's-pdf-12');
    await openApply();
    await until(() => generate() && !generate()!.disabled, 'Generate CV PDF enabled');
  });
});

// A tracker number moves to another application when it is reused: deleting the top row frees it for the next addition.
describe('Given the row number now belongs to another application (R32-feat-a-L2-01)', () => {
  const BETA_12 = { company: 'Beta Labs', role: 'Data Engineer', report: 44 };
  const generate = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith('Generate CV PDF'));
  const markApplied = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Mark applied');
  beforeEach(() => vi.stubGlobal('EventSource', class { addEventListener() {} close() {} }));

  it('When its Apply page opens, Then the earlier application\'s draft is not re-attached and Mark applied names the row shown', async () => {
    await openApply();
    await draftAnswers();
    expect(fillButton()).toBeDefined();

    await act(async () => root.unmount());
    panels = [];
    await openApply('12', undefined, BETA_12);
    expect(applyPanel()!.sessionId ?? null).toBeNull();
    await until(() => draftButton(), 'the Draft answers button');
    expect(fillButton()).toBeUndefined();
    expect(sessionStorage.getItem('cc.apply.12')).toBeNull();

    await act(async () => markApplied()!.click());
    await until(() => statusPosts.length > 0 || undefined, 'the Mark applied post');
    expect(statusPosts).toEqual([{ row: 12, state: 'Applied', expectCompany: 'Beta Labs', expectRole: 'Data Engineer', expectReport: 44 }]);
  });

  it('When the earlier application\'s draft comes back for its own row, Then it is still re-attached', async () => {
    await openApply();
    await draftAnswers();
    await act(async () => root.unmount());
    panels = [];
    await openApply();
    expect(applyPanel()).toMatchObject({ sessionId: 's-apply-12' });
  });

  it('When the earlier application\'s tailored CV session still runs, Then it does not hold Generate CV PDF off for the row shown', async () => {
    docs = { pdfs: [], covers: [], suggestedPdf: null, suggestedCover: null };
    // The sessions list shows the CV session once it started.
    let listed = false;
    const inner = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (input === '/api/sessions' && init?.method !== 'POST') {
        // The server pins the row a session started on (#264), so it starts the new owner's CV beside this one.
        return json(listed ? [{ ...URL_SESSION, id: 's-pdf-12', mode: 'pdf', status: 'running', target: { type: 'app', value: '12', row: ROW_12 } }] : []);
      }
      return inner(input, init);
    });
    await openApply();
    await act(async () => (await until(() => generate() && !generate()!.disabled && generate(), 'Generate CV PDF on')).click());
    listed = true;
    await until(() => router.state.location.pathname === '/sessions/s-pdf-12', 'the session page');

    await act(async () => root.unmount());
    panels = [];
    await openApply('12', undefined, BETA_12);
    await until(() => generate() && !generate()!.disabled && generate(), 'Generate CV PDF on');
    expect(host.querySelector('a[href="/sessions/s-pdf-12"]')).toBeNull();
  });
});

// The tracker query refetches after a delete elsewhere, so the number can change owner while the page stays open.
// The server pins the application an app session started on (target.row), so the CV session of the row's earlier owner
// is told apart from the new owner's however it was started; a session from before the pin is held by its number alone.
describe('Given a live tailored CV session on a reused row number (R33-feat-a-X-01, R33-feat-a-L2-01)', () => {
  const BETA_12 = { company: 'Beta Labs', role: 'Data Engineer', report: 44 };
  const generate = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith('Generate CV PDF'));
  const listing = (target: SessionMeta['target']) => {
    const inner = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (input === '/api/sessions' && init?.method !== 'POST') return json([{ ...URL_SESSION, id: 's-pdf-old', mode: 'pdf', status: 'running', target }]);
      return inner(input, init);
    });
  };
  beforeEach(() => {
    vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
    docs = { pdfs: [], covers: [], suggestedPdf: null, suggestedCover: null };
  });

  it('When it was started elsewhere for the earlier owner, Then it does not hold Generate CV PDF off and is not linked as the new owner\'s', async () => {
    // Started from AskDrawer or the Documents tab: no cc.apply.row marker, only the row the server pinned.
    listing({ type: 'app', value: '12', row: ROW_12 });
    await openApply('12', undefined, BETA_12);
    await until(() => generate() && !generate()!.disabled && generate(), 'Generate CV PDF on');
    expect(host.querySelector('a[href="/sessions/s-pdf-old"]')).toBeNull();
  });

  it('When it was started elsewhere for the row shown, Then Generate CV PDF stays off and links it', async () => {
    listing({ type: 'app', value: '12', row: BETA_12 });
    sessionStorage.setItem('cc.apply.row.s-pdf-old', JSON.stringify(ROW_12));
    await openApply('12', undefined, BETA_12);
    await until(() => host.querySelector('a[href="/sessions/s-pdf-old"]'), 'the link to the running CV session');
    expect(generate()!.disabled).toBe(true);
  });

  it('When it carries no pinned row, Then the server holds the number, so Generate CV PDF stays off and links the session in the way', async () => {
    listing({ type: 'app', value: '12' });
    sessionStorage.setItem('cc.apply.row.s-pdf-old', JSON.stringify(ROW_12));
    await openApply('12', undefined, BETA_12);
    await until(() => host.querySelector('a[href="/sessions/s-pdf-old"]'), 'the link to the running CV session');
    expect(generate()!.disabled).toBe(true);
    expect(host.textContent).toContain('the earlier application');
  });
});

describe('Given the row number changes owner while its Apply page is open (R33-feat-a-L1-01)', () => {
  const BETA_12 = { company: 'Beta Labs', role: 'Data Engineer', report: 44 };
  let reindex: (identity: typeof ROW_12) => void;
  let turnPosts: string[];
  beforeEach(() => {
    vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
    turnPosts = [];
    const inner = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (typeof input === 'string' && /^\/api\/sessions\/[^/]+\/turns$/.test(input) && init?.method === 'POST') turnPosts.push(String(init.body));
      if (input === '/api/sessions/s-apply-beta/turns' && init?.method === 'POST') return json({ ...URL_SESSION, id: 's-apply-beta', status: 'running', target: { type: 'app', value: '12' } });
      return inner(input, init);
    });
  });
  async function openReindexable() {
    const { useState } = await import('react');
    const { ApplyBody } = await import('@web/features/apply/ApplyPage');
    const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
    function Shown() {
      const [identity, setIdentity] = useState(ROW_12);
      reindex = setIdentity;
      return createElement(ApplyBody, { n: '12', company: (identity ?? ROW_12).company, postingUrl: 'https://jobs.example.com/acme/1', identity });
    }
    const rootRoute = createRootRoute({ component: () => createElement(ConfirmProvider, null, createElement(Outlet)) });
    const apply = createRoute({ getParentRoute: () => rootRoute, path: '/apply', component: Shown });
    router = createRouter({ routeTree: rootRoute.addChildren([apply]), history: createMemoryHistory({ initialEntries: ['/apply'] }) });
    root = createRoot(host);
    await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(RouterProvider, { router }))));
    await until(() => applyPanel(), 'the apply session panel');
  }

  it('When the tracker reindexes, Then the earlier application\'s answers leave the form and its draft\'s kept keys go', async () => {
    await openReindexable();
    await act(async () => draftButton()!.click());
    await draftAnswers();
    expect(fillButton()).toBeDefined();
    expect(sessionStorage.getItem('cc.apply.row.s-apply-12')).not.toBeNull();

    await act(async () => reindex(BETA_12));
    await until(() => draftButton(), 'the Draft answers button');
    expect(host.querySelector('[aria-label="Drafted answers"]')).toBeNull();
    expect(fillButton()).toBeUndefined();
    expect(sessionStorage.getItem('cc.apply.12')).toBeNull();
    expect(sessionStorage.getItem('cc.apply.row.s-apply-12')).toBeNull();
    expect(sessionStorage.getItem('cc.apply.docs.s-apply-12')).toBeNull();
  });

  it('When a draft for the new owner stops before its answers, Then Fill cannot send the earlier application\'s answers to it', async () => {
    await openReindexable();
    await draftAnswers();
    await act(async () => reindex(BETA_12));
    await until(() => draftButton(), 'the Draft answers button');
    await act(async () => draftButton()!.click());
    await act(async () => applyPanel()!.onSessionId!('s-apply-beta'));
    await act(async () => applyPanel()!.onStatus!('awaiting_user', null));
    expect(fillButton()).toBeUndefined();
    expect(host.textContent).not.toContain('Jane Smith');
    expect(turnPosts).toEqual([]);
  });
});

describe('Mark applied does not roll back a row that is further along (R30-feat-a-L2-01)', () => {
  const markApplied = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Mark applied');

  it('Given an Evaluated row, When Mark applied is clicked, Then the row is set to Applied without asking', async () => {
    await openApply('12', 'Evaluated');
    await act(async () => markApplied()!.click());
    await until(() => statusPosts.length > 0, 'the status action');
    expect(dialog()).toBeNull();
    expect(statusPosts).toEqual([APPLIED_12]);
  });

  it('Given a row already Applied, When the page opens, Then Mark applied is not offered', async () => {
    await openApply('12', 'Applied');
    expect(markApplied()).toBeUndefined();
  });

  it('Given an Interview row, When Mark applied is clicked and the confirm naming Interview is cancelled, Then the status is left alone', async () => {
    await openApply('12', 'Interview');
    await act(async () => markApplied()!.click());
    await until(() => dialog(), 'the confirm');
    expect(dialog()!.textContent).toContain('Interview');
    await act(async () => [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Cancel')!.click());
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(statusPosts).toEqual([]);
  });

  it('Given an Offer row, When Mark applied is clicked and the confirm is accepted, Then the row is set to Applied', async () => {
    await openApply('12', 'Offer');
    await act(async () => markApplied()!.click());
    await until(() => dialog(), 'the confirm');
    expect(dialog()!.textContent).toContain('Offer');
    await act(async () => [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent !== 'Cancel')!.click());
    await until(() => statusPosts.length > 0, 'the status action');
    expect(statusPosts).toEqual([APPLIED_12]);
  });
});

describe('Mark applied names the row it shows, so a reindex cannot mark another application (R30-feat-c-L2-01b)', () => {
  const markApplied = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Mark applied');

  it('Given row #12 shown as Acme Robotics, When Mark applied is clicked, Then the status action carries its company, role and report', async () => {
    await openApply('12', 'Evaluated');
    await act(async () => markApplied()!.click());
    await until(() => statusPosts.length > 0, 'the status action');
    expect(statusPosts).toEqual([APPLIED_12]);
  });

  it('Given another row now sits under #12, When Mark applied is clicked, Then the server refusal is shown and nothing claims success', async () => {
    const error = 'Row #12 now holds Globex (Platform Engineer), not the row you picked. Reload the tracker.';
    statusRefusal = { status: 409, body: { error } };
    await openApply('12', 'Evaluated');
    await act(async () => markApplied()!.click());
    await until(() => host.textContent?.includes(error) || undefined, 'the refusal message');
    expect(host.textContent).not.toContain('Marked as Applied');
  });
});

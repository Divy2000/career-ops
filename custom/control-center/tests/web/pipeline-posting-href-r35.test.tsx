// Pipeline links a row's posting through the shared postingHref guard (R35-web1-FC-01). data/pipeline.md and
// data/shortlist.md are filled by other writers, so a javascript: or data: URL there renders as text, not as a link
// that would run in the Control Center's origin when clicked.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineRead, PipelineRow, ShortlistRead } from '@shared/api';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@web/components/SessionPanel', () => ({ SessionPanel: () => null }));

const EVIL = 'javascript:alert(document.domain)';
const row = (url: string, company: string, line: number): PipelineRow => ({ url, company, role: `${company} Engineer`, location: null, compensation: null, done: false, needsJd: false, section: 'pending', postedAt: null, rank: null, rankReason: null, note: null, firstSeen: null, source: 'other', seniority: null, line }) as PipelineRow;
const pipeline: PipelineRead = { kind: 'ok', path: 'data/pipeline.md', etag: 'e', rows: [row('https://jobs.example.com/good', 'Good', 3), row(EVIL, 'Evil', 4)] };
const shortlist: ShortlistRead = {
  kind: 'ok', path: 'data/shortlist.md', date: null, summary: null, etag: 'e',
  rows: [
    { rank: 1, score: 4, relevance: null, sponsor: '', sponsorTier: '', sponsorNote: null, company: 'Good', role: 'Good Role', url: 'https://jobs.example.com/good', location: null, posted: null, why: null },
    { rank: 2, score: 4, relevance: null, sponsor: '', sponsorTier: '', sponsorNote: null, company: 'Evil', role: 'Evil Role', url: EVIL, location: null, posted: null, why: null },
  ],
  excluded: [{ company: 'Bad', role: 'Bad Role', url: 'data:text/html,<script>alert(1)</script>', alert: 'paused', date: null, headline: 'h' }],
};

let host: HTMLElement;
let root: Root;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/pipeline' ? json(pipeline) : url === '/api/shortlist' ? json(shortlist) : json([]))));
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function mount(tab: 'inbox' | 'shortlist') {
  const { PipelinePage } = await import('@web/features/pipeline/PipelinePage');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  root = createRoot(host);
  const rootRoute = createRootRoute();
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/pipeline', component: PipelinePage, validateSearch: () => ({ tab }) });
  const router = createRouter({ routeTree: rootRoute.addChildren([page]), history: createMemoryHistory({ initialEntries: ['/pipeline'] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(ConfirmProvider, null, createElement(RouterProvider, { router })))));
}

const hrefs = () => [...host.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
const linkTo = (text: string) => [...host.querySelectorAll('a')].find((a) => a.textContent?.trim() === text);

describe('Pipeline posting links (R35-web1-FC-01)', () => {
  it('given an inbox row with a javascript: URL, then its role is text while an http(s) row stays a link', async () => {
    await mount('inbox');
    await until(() => linkTo('Good Engineer'), 'the Good row link');
    await until(() => host.textContent?.includes('Evil Engineer'), 'the Evil row');
    expect(linkTo('Good Engineer')!.getAttribute('href')).toBe('https://jobs.example.com/good');
    expect(linkTo('Evil Engineer')).toBeUndefined();
    expect(hrefs().filter((h) => /^\s*(javascript|data):/i.test(h))).toEqual([]);
  });

  it('given shortlist and excluded rows with javascript: and data: URLs, then their roles are text', async () => {
    await mount('shortlist');
    await until(() => linkTo('Good Role'), 'the Good shortlist link');
    await until(() => host.textContent?.includes('Bad Role'), 'the excluded row');
    expect(host.textContent).toContain('Evil Role');
    expect(linkTo('Evil Role')).toBeUndefined();
    expect(linkTo('Bad Role')).toBeUndefined();
    expect(hrefs().filter((h) => /^\s*(javascript|data):/i.test(h))).toEqual([]);
  });
});

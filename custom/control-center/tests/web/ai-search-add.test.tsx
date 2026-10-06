// Discover > AI search adds the offers its session emits through POST /api/pipeline/add. The envelope has no length
// limits and the route does, so the page must send what the route accepts, and say why when the route refuses.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PIPELINE_OFFER_LIMITS } from '@shared/pipeline-add';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let emitEnvelope: ((kind: string, payload: unknown, turn: number) => void) | null = null;
vi.mock('@web/components/SessionPanel', () => ({
  SessionPanel: (props: { onEnvelope?: (kind: string, payload: unknown, turn: number) => void }) => {
    emitEnvelope = props.onEnvelope ?? null;
    return null;
  },
}));

type Offer = { url: string; company: string; title: string; location?: string; portal?: string; postedAt?: string };
let posted: Array<{ offers: Offer[] }>;
let addResponse: (body: { offers: Offer[] }) => Response;
let host: HTMLElement;
let root: Root;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The route's own limits (server/routes/writes.ts): a field past them is a 400 for the whole body. */
function routeLike(body: { offers: Offer[] }): Response {
  const tooLong = body.offers.some((o) => o.company.length > PIPELINE_OFFER_LIMITS.company || o.title.length > PIPELINE_OFFER_LIMITS.title || (o.location ?? '').length > PIPELINE_OFFER_LIMITS.location);
  return tooLong ? json(400, { error: 'invalid body' }) : json(200, { added: body.offers.length, skipped: 0 });
}

beforeEach(async () => {
  document.body.innerHTML = '';
  posted = [];
  addResponse = routeLike;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      // Like the server: what an add wrote is in the pipeline the next time it is read.
      if (url === '/api/pipeline') return json(200, { kind: 'ok', path: 'data/pipeline.md', rows: posted.flatMap((b) => b.offers.map((o) => ({ url: o.url }))), etag: 'e' });
      if (url === '/api/tracker') return json(200, { kind: 'ok', rows: [] });
      if (url === '/api/pipeline/add' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { offers: Offer[] };
        posted.push(body);
        return addResponse(body);
      }
      return json(404, { error: 'not stubbed' });
    }),
  );
  const { AiSearchTab } = await import('@web/features/discover/AiSearchTab');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(AiSearchTab))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(name))!;
const status = () => host.querySelector('[role="status"]')?.textContent ?? '';
async function until(fn: () => boolean, what: string) {
  for (let i = 0; i < 50; i++) {
    if (fn()) return;
    await act(async () => new Promise((r) => setTimeout(r, 20)));
  }
  throw new Error(`timed out waiting for ${what}: ${status()}`);
}

describe('Discover > AI search: add', () => {
  it('Add all new shortens a location or title past the route limits and adds every offer', async () => {
    const offices = Array.from({ length: 30 }, (_, i) => `Office ${i + 1}, Somewhere`).join('; ');
    await act(async () => emitEnvelope!('offer', { url: 'https://jobs.example.com/1', company: 'Acme', title: 'Backend Engineer', location: offices }, 1));
    await act(async () => emitEnvelope!('offer', { url: 'https://jobs.example.com/2', company: 'Globex', title: `Platform Engineer ${'x'.repeat(400)}` }, 1));
    await act(async () => button('Add all new').click());
    await until(() => status().startsWith('Added'), 'the add result');
    expect(status()).toBe('Added 2 to the pipeline');
    expect(posted).toHaveLength(1);
    const [first, second] = posted[0]!.offers;
    expect(first!.location!.length).toBeLessThanOrEqual(PIPELINE_OFFER_LIMITS.location);
    expect(first!.location!.startsWith('Office 1, Somewhere')).toBe(true);
    expect(second!.title.length).toBeLessThanOrEqual(PIPELINE_OFFER_LIMITS.title);
    expect(second).not.toHaveProperty('location');
  });

  it('an offer the server skips as already listed (its URL differs only by tracking parameters) is reported as already there, not added (SW-web-a-05)', async () => {
    addResponse = (body) => json(200, { added: 0, skipped: body.offers.length });
    await act(async () => emitEnvelope!('offer', { url: 'https://boards.greenhouse.io/acme/jobs/123?gh_src=x', company: 'Acme', title: 'Backend Engineer' }, 1));
    await act(async () => button('Add all new').click());
    await until(() => status().startsWith('Added'), 'the add result');
    expect(status()).toBe('Added 0 to the pipeline; 1 was already there');
    const row = host.querySelector('tbody tr')!;
    expect(row.textContent).toContain('already there');
    expect(row.textContent).not.toMatch(/\badded\b/);
    expect(row.querySelector('button')!.disabled).toBe(true);
  });

  it('a batch the server adds only partly says how many were added and how many were already there (SW-web-a-05)', async () => {
    addResponse = () => json(200, { added: 1, skipped: 1 });
    await act(async () => emitEnvelope!('offer', { url: 'https://jobs.example.com/new', company: 'Acme', title: 'SRE' }, 1));
    await act(async () => emitEnvelope!('offer', { url: 'https://jobs.example.com/old?utm_source=x', company: 'Globex', title: 'SRE' }, 1));
    await act(async () => button('Add all new').click());
    await until(() => status().startsWith('Added'), 'the add result');
    expect(status()).toBe('Added 1 to the pipeline; 1 was already there');
    expect([...host.querySelectorAll('tbody tr')].map((tr) => tr.querySelectorAll('td')[3]!.textContent)).toEqual(['in pipeline', 'in pipeline']);
  });

  it('sends the offer source and posted day, so the pipeline row and scan history keep them (SW-web-a-05)', async () => {
    await act(async () => emitEnvelope!('offer', { url: 'https://jobs.example.com/4', company: 'Hooli', title: 'SRE', source: 'greenhouse', postedAt: '2026-10-01' }, 1));
    await act(async () => button('Add all new').click());
    await until(() => status().startsWith('Added'), 'the add result');
    expect(posted[0]!.offers).toEqual([{ url: 'https://jobs.example.com/4', company: 'Hooli', title: 'SRE', portal: 'greenhouse', postedAt: '2026-10-01' }]);
  });

  it('an offer just added keeps its added pill after the pipeline refetch lists it (SW4-web-a-04)', async () => {
    await act(async () => emitEnvelope!('offer', { url: 'https://jobs.example.com/fresh', company: 'Fresh Co', title: 'SRE' }, 1));
    await act(async () => button('Add all new').click());
    await until(() => status().startsWith('Added'), 'the add result');
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    const row = host.querySelector('tbody tr')!;
    expect(row.querySelectorAll('td')[3]!.textContent).toBe('added');
    expect(row.querySelector('button')!.disabled).toBe(true);
  });

  it('a refused add shows the server reason, not just the status line', async () => {
    addResponse = () => json(409, { error: 'pipeline is busy, try again in a moment' });
    await act(async () => emitEnvelope!('offer', { url: 'https://jobs.example.com/3', company: 'Initech', title: 'SRE' }, 1));
    await act(async () => button('Add all new').click());
    await until(() => status().startsWith('Could not add'), 'the refusal');
    expect(status()).toBe('Could not add: pipeline is busy, try again in a moment');
  });
});

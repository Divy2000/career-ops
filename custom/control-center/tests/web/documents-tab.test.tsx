import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '@web/components/ConfirmDialog';
import { DocumentsTab } from '@web/features/tracker/DocumentsTab';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

const RENDER_META = { id: 'docs.renderPdf', label: 'Re-render PDF from HTML', cost: 'free', confirm: null, resources: [], claude: false, sync: false, params: {} };
let files = (rerenderBlock: string | null) => [{ path: 'output/acme-robotics-cv.pdf', html: 'output/acme-robotics-cv.html', kind: 'cv', format: 'letter', date: null, source: 'index', rerenderBlock }];
const docsFor = (report: number | null, rerenderBlock: string | null = null) => ({
  files: files(rerenderBlock),
  jds: [],
  indexPresent: true,
  report,
});

async function mount(row: number, report: number | null, rerenderBlock: string | null = null, meta: object = RENDER_META) {
  const posts: unknown[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = url === '/api/actions' ? [meta] : url.endsWith('/documents') ? docsFor(report, rerenderBlock) : url.startsWith('/api/actions/') ? { runId: 'r1' } : [];
    if (init?.method === 'POST') posts.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(DocumentsTab, { n: row })))));
  // Both the listing and the action metadata: without the metadata no Re-render button renders at all.
  await until(() => host.querySelector('table[aria-label="Generated documents"]') && qc.getQueryState(['actions'])?.status === 'success', 'the documents listing and the actions');
  return posts;
}

const rerenderButton = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Re-render from HTML'))!;
const BLOCK = 'output/acme-robotics-cv.pdf belongs to report 99, so re-rendering it here would file it under report 1. Re-render it from that application instead.';

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

describe('DocumentsTab re-render', () => {
  it('files the re-render under the row report number', async () => {
    const posts = await mount(9, 1);
    expect(rerenderButton().disabled).toBe(false);
    await act(async () => rerenderButton().click());
    await until(() => posts.length > 0, 'the re-render request');
    expect(posts).toEqual([{ params: { row: 9, report: 1, html: 'output/acme-robotics-cv.html', pdf: 'output/acme-robotics-cv.pdf', format: 'letter' } }]);
  });

  it('does not offer re-render for a file another report owns and says why', async () => {
    await mount(1, 1, BLOCK);
    expect(rerenderButton()).toBeUndefined();
    expect(host.textContent).toContain(BLOCK);
  });

  it('disables re-render with the reason when the row has no report', async () => {
    await mount(5, null);
    expect(rerenderButton().disabled).toBe(true);
    expect(host.textContent).toContain('Re-render needs an evaluation report for this application, because the PDF index files every PDF under its report number.');
  });

  it('does not offer re-render for a file whose name the re-render action refuses, and says to rename it, by the shared output/ rule (SW3-web-a-03)', async () => {
    const original = files;
    files = () => [{ path: 'output/odd\u0007name.pdf', html: 'output/odd\u0007name.html', kind: 'cv', format: 'letter', date: null, source: 'output', rerenderBlock: null }];
    try {
      await mount(1, 1, null);
      expect(rerenderButton()).toBeUndefined();
      expect(host.textContent).toContain("Re-render can't take output/odd\u0007name.html: a file name with a control character. Rename it and its PDF in output/.");
    } finally {
      files = original;
    }
  });

  it('offers re-render for a file dropped into output/ under a name with spaces (seed: SW3-web-a-03)', async () => {
    const original = files;
    files = () => [{ path: 'output/Acme Resume.pdf', html: 'output/Acme Resume.html', kind: 'cv', format: 'letter', date: null, source: 'output', rerenderBlock: null }];
    try {
      await mount(1, 1, null);
      expect(rerenderButton()).toBeDefined();
    } finally {
      files = original;
    }
  });

  it('re-renders a file with no recorded format without naming one, so generate-pdf uses the profile\'s page_format (SW5-web-a-01)', async () => {
    const original = files;
    files = () => [{ path: 'output/cv-acme-swe.pdf', html: 'output/cv-acme-swe.html', kind: 'cv', format: null, date: null, source: 'output', rerenderBlock: null }] as unknown as ReturnType<typeof original>;
    try {
      const posts = await mount(9, 12);
      await act(async () => rerenderButton().click());
      await until(() => posts.length > 0, 'the re-render request');
      expect(posts).toEqual([{ params: { row: 9, report: 12, html: 'output/cv-acme-swe.html', pdf: 'output/cv-acme-swe.pdf' } }]);
    } finally {
      files = original;
    }
  });
});


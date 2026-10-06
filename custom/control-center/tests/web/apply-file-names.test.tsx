// Apply: a PDF dropped into output/ by hand ("Acme Resume.pdf") is listed and can be preselected, but the prefill
// action's schema refuses its name. The page says so up front instead of failing with "invalid params" (SW3-web-a-03).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@web/components/SessionPanel', () => ({ SessionPanel: () => null }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => async () => undefined,
}));

/** docs.prepareApplication as GET /api/actions describes it: the zod schema as JSON schema, its path pattern included. */
const OUTPUT_FILE = { type: 'string', maxLength: 512, pattern: '^output\\/(?:[\\w.-]+\\/)*[\\w.-]+$' };
const PREFILL_META = { id: 'docs.prepareApplication', label: 'Prepare application', cost: 'network', confirm: null, resources: [], claude: false, sync: true, params: { type: 'object', properties: { url: { type: 'string' }, pdf: OUTPUT_FILE, cover: OUTPUT_FILE }, required: ['url', 'pdf'] } };

let host: HTMLElement;
let root: Root;
let posts: string[];

beforeEach(async () => {
  posts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push(url);
      const body =
        url === '/api/actions' ? [PREFILL_META] : url === '/api/sessions/engine' ? { playwrightAvailable: false, modes: [] } : url === '/api/apply/documents' ? { pdfs: ['output/Acme Resume.pdf', 'output/cv-acme.pdf'], covers: [], suggestedPdf: 'output/Acme Resume.pdf', suggestedCover: null } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  const { ApplyPage } = await import('@web/features/apply/ApplyPage');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ApplyPage))));
  await until(() => host.querySelector('select[aria-label="CV PDF to attach"]'), 'the PDF picker');
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const prefill = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Zero-token prefill'))!;

async function setValue(label: string, value: string) {
  const el = host.querySelector<HTMLSelectElement | HTMLInputElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

describe('Apply: a PDF whose name the prefill action refuses', () => {
  it('blocks the prefill with a reason that says to rename the file, and sends nothing', async () => {
    await setValue('Posting URL', 'https://boards.greenhouse.io/acme/jobs/1');
    await until(() => prefill().disabled, 'the prefill to be blocked');
    expect(host.textContent).toContain("Prefill can't take output/Acme Resume.pdf: its name may only use letters, digits and . _ -. Rename it in output/.");
    expect(posts).toEqual([]);
  });

  it('a PDF with an accepted name prefills', async () => {
    await setValue('Posting URL', 'https://boards.greenhouse.io/acme/jobs/1');
    await setValue('CV PDF to attach', 'output/cv-acme.pdf');
    expect(prefill().disabled).toBe(false);
  });
});

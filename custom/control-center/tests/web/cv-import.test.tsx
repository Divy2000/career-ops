import { createElement, useEffect } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionPanelProps } from '@web/components/SessionPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Each mounted parser panel, by the upload it was started for, with the envelope callback it was given.
const panels = vi.hoisted(() => ({ mounts: [] as string[], unmounts: [] as string[], onEnvelope: new Map<string, SessionPanelProps['onEnvelope']>() }));
vi.mock('@web/components/SessionPanel', () => ({
  SessionPanel: (props: SessionPanelProps) => {
    const value = String((props.target as { value?: string } | undefined)?.value ?? '');
    panels.onEnvelope.set(value, props.onEnvelope);
    useEffect(() => {
      panels.mounts.push(value);
      return () => void panels.unmounts.push(value);
    }, []);
    return createElement('div', { 'data-testid': 'session-panel' }, value);
  },
}));

let host: HTMLElement;
let root: Root;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function mount() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const upload = String(input).match(/^\/api\/cv\/upload\?name=(.+)$/);
      if (upload) return json(200, { path: `/data/uploads/${decodeURIComponent(upload[1]!)}`, bytes: 3 });
      return json(404, { error: 'not stubbed' });
    }),
  );
  const { CvImport } = await import('@web/features/profile/ProfilePage');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(CvImport))));
}

async function choose(name: string, type: string, text = 'abc') {
  const input = host.querySelector<HTMLInputElement>('input[type="file"][aria-label="CV file"]')!;
  const file = new File([text], name, { type });
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  for (let i = 0; i < 20; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
}

const draft = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="CV markdown"]')!.value;
const panelsShown = () => [...host.querySelectorAll('[data-testid="session-panel"]')].map((p) => p.textContent);

beforeEach(() => {
  document.body.innerHTML = '';
  panels.mounts.length = 0;
  panels.unmounts.length = 0;
  panels.onEnvelope.clear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

describe('Import CV: one parser session per uploaded file', () => {
  it('starts a fresh parser panel for a second PDF and retires the first', async () => {
    await mount();
    await choose('a.pdf', 'application/pdf');
    await choose('b.pdf', 'application/pdf');
    expect(panelsShown()).toEqual(['/data/uploads/b.pdf']);
    expect(panels.mounts).toEqual(['/data/uploads/a.pdf', '/data/uploads/b.pdf']);
    expect(panels.unmounts).toEqual(['/data/uploads/a.pdf']);
  });

  it('ignores the cv envelope of a retired session; only the current upload fills the draft', async () => {
    await mount();
    await choose('a.pdf', 'application/pdf');
    const stale = panels.onEnvelope.get('/data/uploads/a.pdf')!;
    await choose('b.pdf', 'application/pdf');
    await act(async () => stale('cv', { markdown: '# From A' }, 1));
    expect(draft()).toBe('');
    await act(async () => panels.onEnvelope.get('/data/uploads/b.pdf')!('cv', { markdown: '# From B' }, 1));
    expect(draft()).toBe('# From B');
  });

  it('retires a running parser when a Markdown file is picked, so its late envelope cannot replace the loaded text', async () => {
    await mount();
    await choose('a.pdf', 'application/pdf');
    const stale = panels.onEnvelope.get('/data/uploads/a.pdf')!;
    await choose('cv.md', 'text/markdown', '# Picked Markdown');
    expect(panelsShown()).toEqual([]);
    expect(draft()).toBe('# Picked Markdown');
    await act(async () => stale('cv', { markdown: '# From A' }, 1));
    expect(draft()).toBe('# Picked Markdown');
  });
});

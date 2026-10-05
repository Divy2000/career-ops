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
let sent: Array<{ url: string; body: unknown }>;
// Held responses: while `hold[kind]` is set, that kind of request waits until its release() is called.
let hold: { upload?: boolean; convert?: boolean };
let held: Array<{ kind: string; url: string; release: () => void }>;
const waitFor = (kind: string, url: string, respond: () => Response) =>
  new Promise<Response>((resolve) => held.push({ kind, url, release: () => resolve(respond()) }));

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function mount() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (typeof init?.body === 'string') sent.push({ url, body: JSON.parse(init.body) });
      if (url === '/api/projects/convert') {
        const body = JSON.parse(String(init?.body)) as { text: string; source?: string };
        const respond = () => json(200, { markdown: `${body.text}\n<!-- ${body.source ?? 'no source'} -->\n`, entries: [{ title: 'X' }], duplicates: [], warnings: [], errors: [] });
        return hold.convert ? waitFor('convert', url, respond) : respond();
      }
      if (url === '/api/projects/append') return json(200, { ok: true, etag: 'e2', recorded: true });
      if (url === '/api/projects' && (init?.method ?? 'GET') === 'GET') return json(200, { path: 'article-digest.md', kind: 'ok', etag: 'e1', validation: { ok: true, errors: [], warnings: [] }, entries: [] });
      const upload = url.match(/^\/api\/projects\/upload\?name=(.+)$/);
      if (upload && upload[1]!.endsWith('.docx')) return json(415, { error: 'intake reads PDF, Markdown and text: export to PDF or .md/.txt first' });
      if (upload) {
        const respond = () => json(200, { path: `projects/${decodeURIComponent(upload[1]!)}`, bytes: 3 });
        return hold.upload ? waitFor('upload', url, respond) : respond();
      }
      return json(404, { error: 'not stubbed' });
    }),
  );
  const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(ProjectsLibrary)))));
}

async function choose(name: string, type: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"][aria-label="Projects file"]')!;
  const file = new File(['abc'], name, { type });
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  for (let i = 0; i < 20; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
}

const importText = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Projects to import"]')!.value;
const panelsShown = () => [...host.querySelectorAll('[data-testid="session-panel"]')].map((p) => p.textContent);

beforeEach(() => {
  document.body.innerHTML = '';
  panels.mounts.length = 0;
  panels.unmounts.length = 0;
  panels.onEnvelope.clear();
  sent = [];
  hold = {};
  held = [];
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

describe('Import projects: parser sessions per uploaded document', () => {
  it('starts a fresh parser panel for each new PDF and retires the old one', async () => {
    await mount();
    await choose('first.pdf', 'application/pdf');
    expect(panelsShown()).toEqual(['projects/first.pdf']);
    await choose('second.pdf', 'application/pdf');
    expect(panelsShown()).toEqual(['projects/second.pdf']);
    expect(panels.mounts).toEqual(['projects/first.pdf', 'projects/second.pdf']);
    expect(panels.unmounts).toEqual(['projects/first.pdf']);
  });

  it('ignores an envelope from the retired session; only the current upload fills the draft', async () => {
    await mount();
    await choose('first.pdf', 'application/pdf');
    const stale = panels.onEnvelope.get('projects/first.pdf')!;
    await choose('second.pdf', 'application/pdf');
    await act(async () => stale('projects', { markdown: '## From First\n- stale.' }, 1));
    expect(importText()).toBe('');
    await act(async () => panels.onEnvelope.get('projects/second.pdf')!('projects', { markdown: '## From Second\n- fresh.' }, 1));
    expect(importText()).toBe('## From Second\n- fresh.');
  });

  it('removes the parser panel when a JSON or Markdown file is chosen next', async () => {
    await mount();
    await choose('first.pdf', 'application/pdf');
    await choose('projects.json', 'application/json');
    expect(panelsShown()).toEqual([]);
  });

  it('names the upload as a documents/ source: the session reads it through intake, and preview and append carry the source', async () => {
    await mount();
    await choose('second.pdf', 'application/pdf');
    expect(host.querySelector('[data-testid="session-panel"]')?.textContent).toBe('projects/second.pdf');
    await act(async () => panels.onEnvelope.get('projects/second.pdf')!('projects', { markdown: '## From Second\n- fresh.' }, 1));
    expect(host.querySelector('[aria-label="Import source"]')?.textContent).toContain('documents/projects/second.pdf');
    const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(label))!;
    await act(async () => button('Preview').click());
    for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(sent.find((c) => c.url === '/api/projects/convert')?.body).toEqual({ format: 'markdown', text: '## From Second\n- fresh.', source: 'projects/second.pdf' });
    await act(async () => button('Append').click());
    for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(sent.find((c) => c.url === '/api/projects/append')?.body).toEqual({ markdown: '## From Second\n- fresh.\n<!-- projects/second.pdf -->\n', source: 'projects/second.pdf' });
  });

  it('shows intake\'s reason when the server refuses a DOCX, and starts no parser', async () => {
    await mount();
    await choose('notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('export to PDF or .md/.txt first');
    expect(panelsShown()).toEqual([]);
  });

  const settle = async () => {
    for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
  };
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(label));
  const fileWith = async (name: string, content: string, type: string) => {
    const input = host.querySelector<HTMLInputElement>('input[type="file"][aria-label="Projects file"]')!;
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [new File([content], name, { type })], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
  };

  it('a slow upload that finishes after a newer choice does not bring back its parser', async () => {
    await mount();
    hold.upload = true;
    await choose('first.pdf', 'application/pdf');
    expect(held.map((h) => h.kind)).toEqual(['upload']);
    await fileWith('projects.json', '[{"name":"Kite"}]', 'application/json');
    await act(async () => held[0]!.release());
    await settle();
    expect(panelsShown()).toEqual([]);
    expect(importText()).toBe('[{"name":"Kite"}]');
    expect(host.querySelector('[aria-label="Import source"]')).toBeNull();
  });

  it('a preview that answers after the draft changed is dropped, so Append never pairs it with the newer source', async () => {
    await mount();
    await choose('first.pdf', 'application/pdf');
    await act(async () => panels.onEnvelope.get('projects/first.pdf')!('projects', { markdown: '## From First\n- a.' }, 1));
    hold.convert = true;
    await act(async () => button('Preview')!.click());
    await choose('second.pdf', 'application/pdf');
    await act(async () => panels.onEnvelope.get('projects/second.pdf')!('projects', { markdown: '## From Second\n- b.' }, 1));
    await act(async () => held[0]!.release());
    await settle();
    expect(host.querySelector('[aria-label="Import preview"]')).toBeNull();
    expect(button('Append')).toBeUndefined();
    hold.convert = false;
    await act(async () => button('Preview')!.click());
    await settle();
    await act(async () => button('Append')!.click());
    await settle();
    expect(sent.filter((c) => c.url === '/api/projects/append').map((c) => c.body)).toEqual([{ markdown: '## From Second\n- b.\n<!-- projects/second.pdf -->\n', source: 'projects/second.pdf' }]);
  });

});

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
// Uploads of a name in `holdNames` wait until the test releases them, so a slow upload can finish after a newer pick.
let holdNames: Set<string>;
let held: Map<string, () => void>;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Answers the cv.md GET and PUT that Save as cv.md sends; unset, they fall through to 404. */
let cvFile: ((method: string) => Response) | null;

async function mount() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/files/user/cv' && cvFile) return cvFile(init?.method ?? 'GET');
      const upload = String(input).match(/^\/api\/cv\/upload\?name=(.+)$/);
      if (upload && upload[1]!.endsWith('.docx')) return json(415, { error: 'the CV parser reads PDF only: export it to PDF, or pick a .md or .txt file to load the text directly' });
      if (upload) {
        const name = decodeURIComponent(upload[1]!);
        const respond = () => json(200, { path: `/data/uploads/${name}`, bytes: 3 });
        if (holdNames.has(name)) return new Promise<Response>((resolve) => held.set(name, () => resolve(respond())));
        return respond();
      }
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
  holdNames = new Set();
  held = new Map();
  cvFile = null;
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

  it('shows the server\'s reason when it refuses a DOCX, and starts no parser', async () => {
    await mount();
    await choose('cv.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('export it to PDF');
    expect(panelsShown()).toEqual([]);
  });

  it('offers only PDF, Markdown and text files', async () => {
    await mount();
    expect(host.querySelector<HTMLInputElement>('input[type="file"][aria-label="CV file"]')!.accept).toBe('.md,.txt,.markdown,.pdf');
  });

  const settle = async () => {
    for (let i = 0; i < 20; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
  };

  it('ignores a slow PDF upload that finishes after a Markdown file was picked: no parser comes back and the loaded text stays', async () => {
    holdNames.add('a.pdf');
    await mount();
    await choose('a.pdf', 'application/pdf');
    await choose('cv.md', 'text/markdown', '# Picked Markdown');
    await act(async () => held.get('a.pdf')!());
    await settle();
    expect(panelsShown()).toEqual([]);
    expect(panels.mounts).toEqual([]);
    expect(draft()).toBe('# Picked Markdown');
  });

  it('ignores a slow PDF upload that finishes after a newer PDF was picked: only the newer one gets a parser', async () => {
    holdNames.add('a.pdf');
    await mount();
    await choose('a.pdf', 'application/pdf');
    await choose('b.pdf', 'application/pdf');
    await act(async () => held.get('a.pdf')!());
    await settle();
    expect(panelsShown()).toEqual(['/data/uploads/b.pdf']);
    expect(panels.mounts).toEqual(['/data/uploads/b.pdf']);
  });
});

describe('Import CV: Save as cv.md', () => {
  const CV = { key: 'cv', path: 'cv.md', kind: 'ok', text: '# Old CV\n', etag: 'e1' };
  async function typeDraft(text: string) {
    const area = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="CV markdown"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  async function clickSave() {
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save as cv.md')!;
    await act(async () => button.click());
    for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
  }
  const alertText = () => host.querySelector('[role="alert"]')?.textContent ?? null;

  it('shows the server\'s reason when the save is refused, and does not say it saved', async () => {
    const reason = 'cv.md leads outside the data root; nothing was written';
    cvFile = (method) => (method === 'PUT' ? json(403, { error: reason }) : json(200, CV));
    await mount();
    await typeDraft('# Imported CV');
    await clickSave();
    expect(alertText()).toContain(reason);
    expect(host.textContent).not.toContain('cv.md saved');
  });

  it('when cv.md changed between reading and saving, says so and shows the current version instead of overwriting it', async () => {
    cvFile = (method) => (method === 'PUT' ? json(409, { error: 'the file changed since you loaded it', current: { ...CV, text: '# Changed on disk\n', etag: 'e2' } }) : json(200, CV));
    await mount();
    await typeDraft('# Imported CV');
    await clickSave();
    expect(alertText()).toMatch(/changed on disk/);
    expect(host.querySelector('details pre')?.textContent).toBe('# Changed on disk\n');
    expect(host.textContent).not.toContain('cv.md saved');
  });

  it('saving again after a conflict saves, and clears the error and the shown version', async () => {
    let puts = 0;
    cvFile = (method) => {
      if (method !== 'PUT') return json(200, CV);
      puts++;
      return puts === 1 ? json(409, { error: 'the file changed since you loaded it', current: { ...CV, text: '# Changed on disk\n', etag: 'e2' } }) : json(200, { ok: true, etag: 'e3', path: 'cv.md' });
    };
    await mount();
    await typeDraft('# Imported CV');
    await clickSave();
    expect(alertText()).toMatch(/changed on disk/);
    await clickSave();
    expect(alertText()).toBeNull();
    expect(host.querySelector('details')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('cv.md saved');
  });
});

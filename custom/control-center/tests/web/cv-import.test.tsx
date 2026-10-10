import { createElement, useEffect } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { until } from '../helpers/until';
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
let cvFile: ((method: string, init?: RequestInit) => Response) | null;

async function mount() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/files/user/cv' && cvFile) return cvFile(init?.method ?? 'GET', init);
      const upload = String(input).match(/^\/api\/cv\/upload\?name=(.+)$/);
      // As the server does (routes/files.ts): the Content-Type decides, never the file name.
      const type = String(new Headers(init?.headers).get('content-type') ?? '').split(';')[0]!.trim();
      if (upload && type !== 'application/pdf') return json(415, { error: 'the CV parser reads PDF only: export it to PDF, or pick a .md or .txt file to load the text directly' });
      if (upload) {
        const name = decodeURIComponent(upload[1]!);
        const respond = () => json(200, { path: `/data/uploads/${name}`, bytes: 3 });
        if (holdNames.has(name)) {
          const response = respond();
          return new Promise<Response>((resolve) => held.set(name, () => resolve(response)));
        }
        return respond();
      }
      return json(404, { error: 'not stubbed' });
    }),
  );
  const { CvImport } = await import('@web/features/profile/ProfilePage');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(CvImport)))));
}

async function choose(name: string, type: string, text = 'abc') {
  const input = host.querySelector<HTMLInputElement>('input[type="file"][aria-label="CV file"]')!;
  const file = new File([text], name, { type });
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // What the pick leads to: a held upload is in flight, a PDF gets its parser panel, a text file fills the draft, and
  // anything else is refused with a note (SW2-tests-21: no fixed sleep before the asserts).
  if (holdNames.has(name)) await until(() => held.has(name), `the ${name} upload request`);
  else if (/\.pdf$/i.test(name)) await until(() => panelsShown().includes(`/data/uploads/${name}`), `the ${name} parser panel`);
  else if (/\.(md|txt|markdown)$/i.test(name)) await until(() => draft() === text, `the ${name} text in the draft`);
  else await until(() => host.querySelector('[role="status"]'), `the note refusing ${name}`);
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

  it('uploads a PDF the browser gave no type as a PDF', async () => {
    await mount();
    await choose('a.pdf', '');
    expect(panelsShown()).toEqual(['/data/uploads/a.pdf']);
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

  /**
   * Releases a held upload and lets the page take its answer: the response, its body, and the render after it. The
   * test then checks nothing changed, which no poll can wait for (SW2-tests-21).
   */
  const release = async (name: string) => {
    await act(async () => held.get(name)!());
    for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setImmediate(r)));
  };

  it('ignores a slow PDF upload that finishes after a Markdown file was picked: no parser comes back and the loaded text stays', async () => {
    holdNames.add('a.pdf');
    await mount();
    await choose('a.pdf', 'application/pdf');
    await choose('cv.md', 'text/markdown', '# Picked Markdown');
    await release('a.pdf');
    expect(panelsShown()).toEqual([]);
    expect(panels.mounts).toEqual([]);
    expect(draft()).toBe('# Picked Markdown');
  });

  it('ignores a slow PDF upload that finishes after a newer PDF was picked: only the newer one gets a parser', async () => {
    holdNames.add('a.pdf');
    await mount();
    await choose('a.pdf', 'application/pdf');
    await choose('b.pdf', 'application/pdf');
    await release('a.pdf');
    expect(panelsShown()).toEqual(['/data/uploads/b.pdf']);
    expect(panels.mounts).toEqual(['/data/uploads/b.pdf']);
  });
});

describe('Import CV: Save as cv.md', () => {
  /** cv.md on disk; the server's 409 answers a PUT whose If-Match is not its current ETag, as the real route does. */
  let disk: { text: string; etag: string | null };
  let puts: Array<{ text: string; ifMatch: string | null }>;
  let refusePut: Response | null;
  const serveCv = () => {
    cvFile = (method, init) => {
      const read = { key: 'cv', path: 'cv.md', kind: disk.etag === null ? 'missing' : 'ok', text: disk.text, etag: disk.etag };
      if (method !== 'PUT') return json(200, read);
      const ifMatch = (init?.headers as Record<string, string> | undefined)?.['If-Match'] ?? null;
      puts.push({ text: (JSON.parse(String(init?.body)) as { text: string }).text, ifMatch });
      if (refusePut) return refusePut;
      if (ifMatch !== disk.etag) return json(409, { error: 'the file changed since you loaded it', current: read });
      disk = { text: (JSON.parse(String(init?.body)) as { text: string }).text, etag: `${disk.etag ?? 'e0'}-saved` };
      return json(200, { ok: true, etag: disk.etag, path: 'cv.md' });
    };
  };
  beforeEach(() => {
    disk = { text: '# Alex Example\n\nBackend engineer, hand-written.\n', etag: 'e1' };
    puts = [];
    refusePut = null;
    serveCv();
  });
  async function typeDraft(text: string) {
    const area = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="CV markdown"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  const alertText = () => host.querySelector('[role="alert"]')?.textContent ?? null;
  /** Clicks Save as cv.md and waits for what it leads to: the Replace dialog, or a save sent without one. */
  async function clickSave() {
    const before = puts.length;
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save as cv.md')!;
    await act(async () => button.click());
    await until(() => dialog() || puts.length > before, 'the Replace dialog or the save');
    if (!dialog()) await until(() => host.querySelector('[role="status"]')?.textContent?.includes('cv.md saved') || alertText(), 'the save result');
  }
  /** The confirm dialog renders in a portal on document.body, outside the component's host. */
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  /** Answers the Replace dialog and waits for the outcome the test expects to check: closed, saved, or refused. */
  async function answer(name: 'Replace cv.md' | 'Cancel', outcome: 'closed' | 'saved' | 'refused' = name === 'Cancel' ? 'closed' : 'saved') {
    const button = [...dialog()!.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;
    await act(async () => button.click());
    await until(
      () => !dialog() && (outcome === 'closed' || (outcome === 'saved' ? host.querySelector('[role="status"]')?.textContent?.includes('cv.md saved') : alertText())),
      `the dialog to close with the ${outcome} outcome`,
    );
  }

  it('asks before replacing a cv.md that already has text, naming what is there, and Cancel writes nothing', async () => {
    await mount();
    await typeDraft('# Imported CV');
    await clickSave();
    expect(dialog()?.textContent).toContain('Replace cv.md?');
    expect(dialog()?.textContent).toContain('# Alex Example');
    await answer('Cancel');
    expect(dialog()).toBeNull();
    expect(puts).toEqual([]);
    expect(disk.text).toBe('# Alex Example\n\nBackend engineer, hand-written.\n');
    expect(host.textContent).not.toContain('cv.md saved');
  });

  it('Replace saves the import over the version the dialog described', async () => {
    await mount();
    await typeDraft('# Imported CV');
    await clickSave();
    await answer('Replace cv.md');
    expect(puts).toEqual([{ text: '# Imported CV', ifMatch: 'e1' }]);
    expect(disk.text).toBe('# Imported CV');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('cv.md saved');
  });

  it('when cv.md changes on disk while the dialog is open, Replace gets the 409 and shows the current version instead of overwriting it', async () => {
    await mount();
    await typeDraft('# Imported CV');
    await clickSave();
    disk = { text: '# Edited in the cv.md editor\n', etag: 'e2' };
    await answer('Replace cv.md', 'refused');
    expect(puts).toEqual([{ text: '# Imported CV', ifMatch: 'e1' }]);
    expect(disk.text).toBe('# Edited in the cv.md editor\n');
    expect(alertText()).toMatch(/changed on disk/);
    expect(host.querySelector('details pre')?.textContent).toBe('# Edited in the cv.md editor\n');
    expect(host.textContent).not.toContain('cv.md saved');
  });

  it('saves without asking when there is no cv.md yet, or it is blank', async () => {
    disk = { text: '', etag: null };
    await mount();
    await typeDraft('# Imported CV');
    await clickSave();
    expect(dialog()).toBeNull();
    expect(puts).toEqual([{ text: '# Imported CV', ifMatch: null }]);
    disk = { text: '  \n', etag: 'e5' };
    await typeDraft('# Imported CV, again');
    await clickSave();
    expect(dialog()).toBeNull();
    expect(puts.at(-1)).toEqual({ text: '# Imported CV, again', ifMatch: 'e5' });
  });

  it('shows the server\'s reason when the save is refused, and does not say it saved', async () => {
    const reason = 'cv.md leads outside the data root; nothing was written';
    refusePut = json(403, { error: reason });
    await mount();
    await typeDraft('# Imported CV');
    await clickSave();
    await answer('Replace cv.md', 'refused');
    expect(alertText()).toContain(reason);
    expect(host.textContent).not.toContain('cv.md saved');
  });

  it('saving again after a conflict asks again over the current version, saves, and clears the error and the shown version', async () => {
    await mount();
    await typeDraft('# Imported CV');
    await clickSave();
    disk = { text: '# Edited in the cv.md editor\n', etag: 'e2' };
    await answer('Replace cv.md', 'refused');
    expect(alertText()).toMatch(/changed on disk/);
    await clickSave();
    expect(dialog()?.textContent).toContain('# Edited in the cv.md editor');
    await answer('Replace cv.md');
    expect(puts.at(-1)).toEqual({ text: '# Imported CV', ifMatch: 'e2' });
    expect(alertText()).toBeNull();
    expect(host.querySelector('details')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('cv.md saved');
  });
});

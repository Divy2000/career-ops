// Profile imports and editors: a PDF parse still running is work the user would lose, so leaving asks and a newer pick
// cancels it; an upload the network drops says so; and a double click on a save sends one write, so the second never
// comes back as the user's own save "changed on disk" (R13-feat-b-L1-03, -L1-04, -L1-05).
import { createElement, type ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionPanelProps } from '@web/components/SessionPanel';
import { UnsavedProvider, useGuardedTab } from '@web/lib/unsaved';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const panels = vi.hoisted(() => new Map<string, SessionPanelProps>());
vi.mock('sonner', () => ({ toast: { success: () => undefined, warning: () => undefined, error: () => undefined } }));
vi.mock('@web/components/SessionPanel', () => ({
  SessionPanel: (props: SessionPanelProps) => {
    panels.set(String((props.target as { value?: string } | undefined)?.value ?? ''), props);
    return null;
  },
}));

let host: HTMLElement;
let root: Root;
let calls: Array<{ method: string; url: string }>;
// Requests to a URL in `holding` wait until released, so a second click can land while the first is in flight.
let holding: Set<string>;
let released: Array<() => void>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  panels.clear();
  calls = [];
  holding = new Set();
  released = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      if (url.includes('down.pdf')) throw new TypeError('Failed to fetch');
      if (holding.has(`${method} ${url}`)) await new Promise<void>((r) => released.push(r));
      const upload = url.match(/^\/api\/(cv|projects)\/upload\?name=(.+)$/);
      if (upload) return json(200, { path: `${upload[1] === 'cv' ? '/data/uploads/' : 'projects/'}${decodeURIComponent(upload[2]!)}`, bytes: 3 });
      if (url.endsWith('/cancel')) return json(200, { status: 'cancelled' });
      if (url === '/api/files/user/cv' || url === '/api/files/user/voiceDna') return method === 'PUT' ? json(200, { ok: true, etag: 'e2' }) : json(200, { key: 'x', path: 'x.md', kind: 'ok', text: '', etag: 'e1' });
      if (url === '/api/projects') return json(200, { path: 'article-digest.md', kind: 'ok', etag: 'e1', validation: { ok: true, errors: [], warnings: [] }, entries: [] });
      if (url === '/api/projects/convert') return json(200, { markdown: '## X\n- y.\n', entries: [{ title: 'X' }], duplicates: [], warnings: [], errors: [] });
      if (url === '/api/projects/append') return json(200, { ok: true, etag: 'e2', warnings: [] });
      return json(404, { error: 'not stubbed' });
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

/** The component inside the unsaved-changes guard, with a guarded "Leave" button standing in for a tab switch. */
function Guarded({ children }: { children: ReactElement }) {
  const leave = useGuardedTab(() => void (host.dataset.left = 'yes'));
  return createElement('div', null, children, createElement('button', { type: 'button', onClick: () => leave(null) }, 'Leave'));
}
async function render(el: ReactElement) {
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ConfirmProvider, null, createElement(UnsavedProvider, null, createElement(Guarded, null, el))))));
}
async function choose(label: string, name: string) {
  const input = host.querySelector<HTMLInputElement>(`input[type="file"][aria-label="${label}"]`)!;
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [new File(['abc'], name, { type: 'application/pdf' })], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(text))!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const sent = (method: string, url: string) => calls.filter((c) => c.method === method && c.url === url).length;

describe('Import CV parse sessions', () => {
  it('leaving while the PDF parse runs asks first, since its result would be lost', async () => {
    const { CvImport } = await import('@web/features/profile/ProfilePage');
    await render(createElement(CvImport));
    await choose('CV file', 'cv.pdf');
    await until(() => panels.get('/data/uploads/cv.pdf'), 'the parser panel');
    await act(async () => button('Leave').click());
    expect((await until(dialog, 'the discard question')).textContent).toContain('the CV import');
  });

  it('a parse that ended without a result no longer holds the page', async () => {
    const { CvImport } = await import('@web/features/profile/ProfilePage');
    await render(createElement(CvImport));
    await choose('CV file', 'cv.pdf');
    const panel = await until(() => panels.get('/data/uploads/cv.pdf'), 'the parser panel');
    await act(async () => panel.onStatus!('error', 'exit 1'));
    await act(async () => button('Leave').click());
    await until(() => host.dataset.left === 'yes', 'leaving without a question');
    expect(dialog()).toBeNull();
  });

  it('a parse waiting for the user\'s reply still holds the page, since its result has not landed', async () => {
    const { CvImport } = await import('@web/features/profile/ProfilePage');
    await render(createElement(CvImport));
    await choose('CV file', 'cv.pdf');
    const panel = await until(() => panels.get('/data/uploads/cv.pdf'), 'the parser panel');
    await act(async () => panel.onStatus!('awaiting_user', 'asked a question'));
    await act(async () => button('Leave').click());
    expect((await until(dialog, 'the discard question')).textContent).toContain('the CV import');
  });

  it('a parse resumed after it ended is tracked again (review)', async () => {
    const { CvImport } = await import('@web/features/profile/ProfilePage');
    await render(createElement(CvImport));
    await choose('CV file', 'cv.pdf');
    const panel = await until(() => panels.get('/data/uploads/cv.pdf'), 'the parser panel');
    await act(async () => panel.onSessionId!('s-cv'));
    await act(async () => panel.onStatus!('error', 'exit 1'));
    await act(async () => panel.onStatus!('running', null));
    await act(async () => button('Leave').click());
    expect((await until(dialog, 'the discard question')).textContent).toContain('the CV import');
  });

  it('a parse whose result landed does not come back as running on a repeated status, so a saved import asks nothing (merge review)', async () => {
    const { CvImport } = await import('@web/features/profile/ProfilePage');
    await render(createElement(CvImport));
    await choose('CV file', 'cv.pdf');
    const panel = await until(() => panels.get('/data/uploads/cv.pdf'), 'the parser panel');
    await act(async () => panel.onSessionId!('s-cv'));
    await act(async () => panel.onStatus!('running', null));
    await act(async () => panel.onEnvelope!('cv', { markdown: '# Parsed CV' }, 1));
    // The panel re-sends its current status after the re-render; then the honesty gate asks a follow-up.
    await act(async () => panels.get('/data/uploads/cv.pdf')!.onStatus!('running', null));
    await act(async () => panels.get('/data/uploads/cv.pdf')!.onStatus!('awaiting_user', 'asked a question'));
    await act(async () => button('Save as cv.md').click());
    await until(() => host.textContent?.includes('cv.md saved'), 'the save');
    await act(async () => button('Leave').click());
    await until(() => host.dataset.left === 'yes', 'leaving without a question');
    expect(dialog()).toBeNull();
    expect(sent('POST', '/api/sessions/s-cv/cancel')).toBe(0);
  });

  it('the parser panel gets the same callbacks on every render, so it does not re-send its status (merge review)', async () => {
    const { CvImport } = await import('@web/features/profile/ProfilePage');
    await render(createElement(CvImport));
    await choose('CV file', 'cv.pdf');
    const first = await until(() => panels.get('/data/uploads/cv.pdf'), 'the parser panel');
    const area = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="CV markdown"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, '# typed');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(panels.get('/data/uploads/cv.pdf')!.onStatus).toBe(first.onStatus);
  });

  it('picking another PDF cancels the parse still running for the first', async () => {
    const { CvImport } = await import('@web/features/profile/ProfilePage');
    await render(createElement(CvImport));
    await choose('CV file', 'one.pdf');
    const first = await until(() => panels.get('/data/uploads/one.pdf'), 'the first parser panel');
    await act(async () => first.onSessionId!('s-one'));
    await act(async () => first.onStatus!('running', null));
    await choose('CV file', 'two.pdf');
    await until(() => sent('POST', '/api/sessions/s-one/cancel') === 1, 'the cancel of the first parse');
  });

  it('a parse whose start answers after a newer pick is cancelled as soon as its id arrives', async () => {
    const { CvImport } = await import('@web/features/profile/ProfilePage');
    await render(createElement(CvImport));
    await choose('CV file', 'one.pdf');
    const first = await until(() => panels.get('/data/uploads/one.pdf'), 'the first parser panel');
    await choose('CV file', 'two.pdf');
    await until(() => panels.get('/data/uploads/two.pdf'), 'the second parser panel');
    await act(async () => first.onSessionId!('s-late'));
    await until(() => sent('POST', '/api/sessions/s-late/cancel') === 1, 'the cancel of the late parse');
  });

  it('an upload the network drops says it failed', async () => {
    const { CvImport } = await import('@web/features/profile/ProfilePage');
    await render(createElement(CvImport));
    await choose('CV file', 'down.pdf');
    await until(() => host.textContent?.includes('Upload failed: Failed to fetch'), 'the upload failure');
  });

  it('a double click on Save as cv.md sends one write', async () => {
    holding.add('PUT /api/files/user/cv');
    const { CvImport } = await import('@web/features/profile/ProfilePage');
    await render(createElement(CvImport));
    const area = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="CV markdown"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, '# Imported');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Save as cv.md').click());
    await until(() => released.length === 1 || undefined, 'the held write');
    await act(async () => button('Save as cv.md').click());
    expect(button('Save as cv.md').disabled).toBe(true);
    await act(async () => released.forEach((r) => r()));
    await until(() => host.textContent?.includes('cv.md saved'), 'the save');
    expect(sent('PUT', '/api/files/user/cv')).toBe(1);
  });
});

describe('UserFileEditor Save', () => {
  it('a double click sends one write', async () => {
    holding.add('PUT /api/files/user/voiceDna');
    const { UserFileEditor } = await import('@web/features/profile/ProfilePage');
    await render(createElement(UserFileEditor, { fileKey: 'voiceDna', label: 'voice-dna.md' }));
    const area = await until(() => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="voice-dna.md contents"]'), 'the editor');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'Plain words.');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Save').click());
    await until(() => released.length === 1 || undefined, 'the held write');
    await act(async () => button('Save').click());
    await act(async () => released.forEach((r) => r()));
    await until(() => host.textContent?.includes('Saved voice-dna.md'), 'the save');
    expect(sent('PUT', '/api/files/user/voiceDna')).toBe(1);
  });
});

describe('Import projects', () => {
  it('leaving while the PDF parse runs asks first, and a newer pick cancels it', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await render(createElement(ProjectsLibrary));
    await until(() => host.querySelector('input[aria-label="Projects file"]'), 'the import card');
    await choose('Projects file', 'one.pdf');
    const first = await until(() => panels.get('projects/one.pdf'), 'the parser panel');
    await act(async () => first.onSessionId!('s-proj'));
    await act(async () => button('Leave').click());
    expect((await until(dialog, 'the discard question')).textContent).toContain('the projects import');
    await act(async () => [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click());
    await choose('Projects file', 'two.pdf');
    await until(() => sent('POST', '/api/sessions/s-proj/cancel') === 1, 'the cancel of the first parse');
  });

  it('an upload the network drops says it failed', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await render(createElement(ProjectsLibrary));
    await until(() => host.querySelector('input[aria-label="Projects file"]'), 'the import card');
    await choose('Projects file', 'down.pdf');
    await until(() => host.textContent?.includes('Upload failed: Failed to fetch'), 'the upload failure');
  });

  it('a double click on Append sends one append', async () => {
    holding.add('POST /api/projects/append');
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await render(createElement(ProjectsLibrary));
    const area = await until(() => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Projects to import"]'), 'the import box');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, '[{"name":"X"}]');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Preview').click());
    await until(() => button('Append'), 'the Append button');
    await act(async () => button('Append').click());
    await until(() => released.length === 1 || undefined, 'the held append');
    await act(async () => button('Append')?.click());
    await act(async () => released.forEach((r) => r()));
    await until(() => !button('Append'), 'the append to finish');
    expect(sent('POST', '/api/projects/append')).toBe(1);
  });
});

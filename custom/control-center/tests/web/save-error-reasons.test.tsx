// Saves and launches that the server refuses show the server's reason, not only the HTTP status line ("502 Bad
// Gateway", "400 Bad Request"): the editors' save errors and the Runs page's launch (SW6-web-b-03).
import { createElement, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let reads: Record<string, unknown>;
let refusal: () => Response;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  reads = {};
  // What the supervisor answers while the server child restarts: plain text, not JSON (supervisor/index.ts).
  refusal = () => new Response('server child unavailable: the app is reloading', { status: 502, headers: { 'content-type': 'text/plain' } });
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') !== 'GET') return refusal();
      if (Object.hasOwn(reads, url)) return json(200, reads[url]);
      // The Runs page's other cards: an empty schedule and job log list.
      if (url === '/api/schedule') return json(200, { jobs: [], agentsDir: '' });
      if (url.startsWith('/api/schedule/logs?')) return json(200, { dates: [], latest: null });
      return json(200, []);
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function mount(child: ReactNode) {
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ConfirmProvider, null, child))));
}
const button = (name: string) => until(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(name) && !b.disabled), `${name} to be ready`);
async function type(el: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const shows = (text: string) => until(() => host.textContent?.includes(text), `"${text}"`);

describe('the server\'s reason for a refused save or launch', () => {
  it('cv.md editor', async () => {
    reads['/api/files/user/cv'] = { key: 'cv', path: 'cv.md', kind: 'ok', text: '# CV\n', etag: 'c1' };
    const { UserFileEditor } = await import('@web/features/profile/ProfilePage');
    await mount(createElement(UserFileEditor, { fileKey: 'cv', label: 'cv.md' }));
    const editor = await until(() => document.querySelector<HTMLTextAreaElement>('[aria-label="cv.md contents"]'), 'the editor');
    await type(editor, '# CV\n- new\n');
    await act(async () => (await button('Save')).click());
    await shows('Could not save: server child unavailable: the app is reloading');
  });

  it('raw YAML editor', async () => {
    reads['/api/config/portals'] = { key: 'portals', path: 'portals.yml', kind: 'ok', raw: 'a: 1\n', etag: 'p1', doc: { a: 1 }, parseError: null };
    const { ConfigEditor } = await import('@web/features/settings/RawConfigEditor');
    await mount(createElement(ConfigEditor, { fileKey: 'portals', label: 'portals.yml', validator: 'validate-portals.mjs' }));
    const editor = await until(() => document.querySelector<HTMLTextAreaElement>('[aria-label="portals.yml YAML"]'), 'the editor');
    await type(editor, 'a: 2\n');
    await act(async () => (await button('Validate and save')).click());
    await shows('Could not save: server child unavailable: the app is reloading');
  });

  it('structured editors', async () => {
    reads['/api/config/portals'] = { key: 'portals', path: 'portals.yml', kind: 'ok', raw: 'a: 1\n', etag: 'p1', doc: { a: 1 }, parseError: null };
    const { useStructuredConfig, EditorNoteView } = await import('@web/features/settings/useStructuredConfig');
    function Harness() {
      const s = useStructuredConfig('portals');
      return createElement('div', null, createElement('button', { type: 'button', onClick: () => s.addOp({ op: 'set', path: ['a'], value: 2 }) }, 'Set a'), createElement('button', { type: 'button', onClick: () => void s.save() }, 'Save it'), createElement(EditorNoteView, { note: s.note }), createElement('output', null, JSON.stringify(s.doc)));
    }
    await mount(createElement(Harness));
    await until(() => host.querySelector('output')?.textContent === '{"a":1}', 'the loaded doc');
    await act(async () => (await button('Set a')).click());
    await act(async () => (await button('Save it')).click());
    await shows('Could not save: server child unavailable: the app is reloading');
  });

  it('Runs & Schedule > Run a script', async () => {
    refusal = () => json(400, { error: 'No replies to review yet. Paste a reply first, then run the digest.' });
    reads['/api/actions'] = [{ id: 'followups.replyWatch', label: 'Reply watch digest', cost: 'free', confirm: null, resources: [], claude: false, sync: false, params: { type: 'object', properties: {} } }];
    const { RunsPage } = await import('@web/features/runs/RunsPage');
    await mount(createElement(RunsPage));
    await act(async () => (await button('Run Reply watch digest')).click());
    await shows('Could not start followups.replyWatch: No replies to review yet. Paste a reply first, then run the digest.');
  });
});

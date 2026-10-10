// Settings saves while a request is still on its way: what the user does meanwhile is neither lost nor turned into a
// false conflict. A structured edit made during a save stays pending (R13-feat-c-L1-01), blacklist rows cannot be
// changed mid-write (R13-feat-c-L1-03), a double click on Save cadence or Validate and save writes once and reports
// success (R13-feat-c-L1-04, R13-feat-c-L3-02), and a second plugin toggle waits for the first (R13-feat-c-L1-05).
import { createElement, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Doc = Record<string, unknown> & { etag: string | null };
type Call = { method: string; url: string; body: unknown; headers: Record<string, string> };

/** The server: GETs answer the current version; a write whose If-Match is stale gets the 409 the real routes send. */
let files: Record<string, Doc>;
let calls: Call[];
/** While set, writes wait for release() before the server answers, as a validator run keeps them waiting. */
let held: Array<() => void> | null;
let host: HTMLElement;
let root: Root;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  held = null;
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, url, body, headers });
      if (url === '/api/actions') return json(200, []);
      const key = url.startsWith('/api/config/plugins/') ? '/api/plugins' : url;
      if (method !== 'GET' && held) await new Promise<void>((r) => held!.push(r));
      const doc = files[key];
      if (!doc) return json(404, { error: 'not stubbed' });
      if (method === 'GET') return json(200, key === '/api/plugins' ? { ...doc, config: { kind: 'ok', path: 'config/plugins.yml', raw: '', etag: doc.etag } } : doc);
      // As the real routes: the write lock serializes saves, and each compares If-Match with the version on disk.
      if ((headers['If-Match'] ?? null) !== doc.etag) return json(409, { error: 'the file changed since you loaded it', current: doc });
      const etag = `${doc.etag}+`;
      files[key] = { ...doc, etag };
      return json(200, { ok: true, etag, warnings: '' });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function mount(child: ReactNode) {
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, child))));
}
const labelled = <T extends HTMLElement>(label: string) => document.querySelector<T>(`[aria-label="${label}"]`);
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === name);
const alerts = () => [...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? '').join('\n');
const writes = () => calls.filter((c) => c.method !== 'GET');
const click = (el: HTMLElement) => act(async () => el.click());
async function release() {
  const waiting = held ?? [];
  held = null;
  await act(async () => {
    for (const r of waiting) r();
  });
}
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('structured editors: an edit made while a save is on its way', () => {
  beforeEach(() => {
    files = { '/api/config/portals': { key: 'portals', path: 'portals.yml', kind: 'ok', raw: 'a: 1\nb: 1\n', etag: 'p1', doc: { a: 1, b: 1 }, parseError: null } };
  });

  async function mountHarness() {
    const { useStructuredConfig, EditorNoteView } = await import('@web/features/settings/useStructuredConfig');
    function Harness() {
      const s = useStructuredConfig('portals');
      return createElement(
        'div',
        null,
        createElement('button', { type: 'button', onClick: () => s.addOp({ op: 'set', path: ['a'], value: 2 }) }, 'Set a'),
        createElement('button', { type: 'button', onClick: () => s.addOp({ op: 'set', path: ['b'], value: 3 }) }, 'Set b'),
        createElement('button', { type: 'button', onClick: () => void s.save() }, 'Save'),
        createElement('button', { type: 'button', onClick: s.discard }, 'Discard'),
        createElement('output', { 'aria-label': 'doc' }, JSON.stringify(s.doc)),
        createElement('output', { 'aria-label': 'pending' }, String(s.pending.length)),
        createElement(EditorNoteView, { note: s.note }),
      );
    }
    await mount(createElement(Harness));
    await until(() => labelled('doc')?.textContent === JSON.stringify({ a: 1, b: 1 }), 'the loaded doc');
  }

  it('stays pending after the save succeeds, and the next save sends it on the version just written', async () => {
    await mountHarness();
    await click(button('Set a')!);
    held = [];
    await click(button('Save')!);
    await until(() => held?.length === 1, 'the save on its way');
    await click(button('Set b')!);
    await release();
    await until(() => /Saved portals\.yml \(1 change, validated\)/.test(document.body.textContent ?? ''), 'the saved note');
    expect(writes()[0]!.body).toEqual({ ops: [{ op: 'set', path: ['a'], value: 2 }] });
    expect(labelled('pending')!.textContent).toBe('1');
    expect(labelled('doc')!.textContent).toBe(JSON.stringify({ a: 2, b: 3 }));
    expect(alerts()).toBe('');
    await click(button('Save')!);
    await until(() => writes().length === 2, 'the second save');
    expect(writes()[1]).toEqual(expect.objectContaining({ body: { ops: [{ op: 'set', path: ['b'], value: 3 }] }, headers: expect.objectContaining({ 'If-Match': 'p1+' }) }));
    await until(() => labelled('pending')!.textContent === '0', 'nothing pending');
  });

  it('stays pending after the save gets a 409', async () => {
    await mountHarness();
    await click(button('Set a')!);
    held = [];
    await click(button('Save')!);
    await until(() => held?.length === 1, 'the save on its way');
    await click(button('Set b')!);
    files['/api/config/portals'] = { ...files['/api/config/portals']!, raw: 'a: 1\nb: 1\nc: 9\n', etag: 'p2', doc: { a: 1, b: 1, c: 9 } };
    await release();
    await until(() => /changed on disk since you loaded it/.test(alerts()), 'the conflict note');
    expect(alerts()).toMatch(/Your 2 pending edit\(s\)/);
    expect(labelled('pending')!.textContent).toBe('2');
    expect(labelled('doc')!.textContent).toBe(JSON.stringify({ a: 2, b: 3, c: 9 }));
  });
  it('Discard does nothing until the save answers, so a later edit is not mistaken for a sent one', async () => {
    await mountHarness();
    await click(button('Set a')!);
    held = [];
    await click(button('Save')!);
    await until(() => held?.length === 1, 'the save on its way');
    await click(button('Discard')!);
    await click(button('Set b')!);
    await release();
    await until(() => /Saved portals\.yml \(1 change, validated\)/.test(document.body.textContent ?? ''), 'the saved note');
    expect(labelled('pending')!.textContent).toBe('1');
    expect(labelled('doc')!.textContent).toBe(JSON.stringify({ a: 2, b: 3 }));
  });
});

describe('blacklist editor: the draft while the confirmed write is on its way', () => {
  beforeEach(() => {
    files = { '/api/blacklist': { kind: 'ok', path: 'data/blacklist.md', raw: '', etag: 'b1', rows: [{ company: 'Initech', since: '2026-01-01', scope: 'company', reason: '' }], preamble: null, postamble: '', extraColumns: [], columnWarning: null, unkept: [] } };
  });

  it('cannot be changed until the write answers, so no row is dropped unsent', async () => {
    const { BlacklistEditor } = await import('@web/features/settings/BlacklistEditor');
    await mount(createElement(BlacklistEditor, {}));
    await type(await until(() => labelled<HTMLInputElement>('Blacklist company or domain'), 'the company field'), 'Globex');
    await click(button('Add row')!);
    held = [];
    await click(button('Save blacklist')!);
    await click(await until(() => button('Write blacklist'), 'the confirm dialog'));
    await until(() => held?.length === 1, 'the write on its way');
    await type(labelled<HTMLInputElement>('Blacklist company or domain')!, 'Umbrella');
    expect(button('Add row')!.disabled).toBe(true);
    expect(button('Remove Initech from the blacklist draft')!.disabled).toBe(true);
    expect(button('Save blacklist')!.disabled).toBe(true);
    expect(button('Discard')!.disabled).toBe(true);
    await release();
    await until(() => /Blacklist written/.test(document.body.textContent ?? ''), 'the written note');
    expect(button('Add row')!.disabled).toBe(false);
    expect(labelled<HTMLInputElement>('Blacklist company or domain')!.value).toBe('Umbrella');
  });
});

describe('a double click on Save', () => {
  it('Save cadence writes once and reports the save, not a conflict', async () => {
    files = { '/api/followups/cadence': { kind: 'ok', etag: 'c1', cadence: { applied_first_days: 7 }, keys: ['applied_first_days'], parseError: null } };
    const { CadenceForm } = await import('@web/features/settings/ProfileForm');
    await mount(createElement(CadenceForm));
    const field = await until(() => document.querySelector<HTMLInputElement>('#cadence-applied_first_days')?.value === '7' && document.querySelector<HTMLInputElement>('#cadence-applied_first_days'), 'the cadence field');
    await type(field, '9');
    held = [];
    const save = button('Save cadence')!;
    await act(async () => {
      save.click();
      save.click();
    });
    await until(() => held!.length >= 1, 'the save on its way');
    await release();
    await until(() => /Follow-up cadence saved/.test(document.body.textContent ?? ''), 'the saved note');
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(writes()).toHaveLength(1);
    expect(alerts()).toBe('');
  });

  it('the cadence fields are locked while the save is on its way, so no edit is cleared unsent', async () => {
    files = { '/api/followups/cadence': { kind: 'ok', etag: 'c1', cadence: { applied_first_days: 7 }, keys: ['applied_first_days'], parseError: null } };
    const { CadenceForm } = await import('@web/features/settings/ProfileForm');
    await mount(createElement(CadenceForm));
    const field = await until(() => document.querySelector<HTMLInputElement>('#cadence-applied_first_days')?.value === '7' && document.querySelector<HTMLInputElement>('#cadence-applied_first_days'), 'the cadence field');
    await type(field, '9');
    held = [];
    await click(button('Save cadence')!);
    await until(() => held!.length === 1, 'the save on its way');
    expect(document.querySelector<HTMLInputElement>('#cadence-applied_first_days')!.disabled).toBe(true);
    await release();
    await until(() => !document.querySelector<HTMLInputElement>('#cadence-applied_first_days')!.disabled, 'the fields back');
  });

  it('Validate and save on the raw YAML writes once and reports the save, not a conflict', async () => {
    files = { '/api/config/portals': { key: 'portals', path: 'portals.yml', kind: 'ok', raw: 'a: 1\n', etag: 'p1', doc: { a: 1 }, parseError: null } };
    const { ConfigEditor } = await import('@web/features/settings/RawConfigEditor');
    await mount(createElement(ConfigEditor, { fileKey: 'portals', label: 'portals.yml', validator: 'validate-portals.mjs' }));
    const editor = await until(() => labelled<HTMLTextAreaElement>('portals.yml YAML')?.value === 'a: 1\n' && labelled<HTMLTextAreaElement>('portals.yml YAML'), 'the editor');
    await type(editor, 'a: 2\n');
    held = [];
    const save = button('Validate and save')!;
    await act(async () => {
      save.click();
      save.click();
    });
    await until(() => held!.length >= 1, 'the save on its way');
    await release();
    await until(() => /Saved portals\.yml/.test(document.body.textContent ?? ''), 'the saved note');
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(writes()).toHaveLength(1);
    expect(alerts()).toBe('');
  });
});

describe('plugin toggles', () => {
  const plugin = (id: string, enabled: boolean) => ({ id, name: id, description: '', version: '1.0.0', hooks: ['export'], requiredEnv: [], optionalEnv: [], humanInTheLoop: false, hasSkill: false, source: 'bundled', enabled, configured: true });

  it('a second toggle waits for the first to land and its refetch, so it never sends the stale ETag', async () => {
    files = { '/api/plugins': { etag: 'g1', plugins: [plugin('alpha', false), plugin('beta', false)] } };
    const { PluginsTab } = await import('@web/features/settings/PluginsTab');
    await mount(createElement(PluginsTab));
    const box = (id: string) => labelled<HTMLInputElement>(`Enable ${id}`);
    await until(() => box('alpha') && box('beta'), 'the plugin rows');
    held = [];
    await click(box('alpha')!);
    await until(() => held?.length === 1, 'the first toggle on its way');
    expect(box('beta')!.disabled).toBe(true);
    expect(box('alpha')!.disabled).toBe(true);
    await release();
    await until(() => !box('beta')!.disabled, 'the toggles back');
    await click(box('beta')!);
    await until(() => writes().length === 2, 'the second toggle');
    expect(writes()[1]!.headers['If-Match']).toBe('g1+');
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(alerts()).toBe('');
  });
});

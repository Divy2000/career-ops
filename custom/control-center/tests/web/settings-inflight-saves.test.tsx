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
import { applyOpsJs } from '@web/lib/yamlOpsClient';
import type { YamlOp } from '@shared/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Doc = Record<string, unknown> & { etag: string | null };
type Call = { method: string; url: string; body: unknown; headers: Record<string, string> };

/** The server: GETs answer the current version; a write whose If-Match is stale gets the 409 the real routes send. */
let files: Record<string, Doc>;
let calls: Call[];
/** While set, writes wait for release() before the server answers, as a validator run keeps them waiting. */
let held: Array<() => void> | null;
/** While set, every GET answers 500, as a server restarting under the post-save refetch does. */
let readsFail: boolean;
/** While set, the next GET reads the file at once but answers only on releaseRead(), as a slow watcher refetch does. */
let slowRead: { release?: () => void } | null;
let host: HTMLElement;
let root: Root;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  held = null;
  readsFail = false;
  slowRead = null;
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
      if (method === 'GET' && readsFail) return json(500, { error: 'internal error' });
      const doc = files[key];
      if (!doc) return json(404, { error: 'not stubbed' });
      if (method === 'GET' && slowRead && !slowRead.release) {
        const waiting = slowRead;
        await new Promise<void>((r) => (waiting.release = r));
      }
      if (method === 'GET') return json(200, key === '/api/plugins' ? { ...doc, config: { kind: 'ok', path: 'config/plugins.yml', raw: '', etag: doc.etag } } : doc);
      // As the real routes: the write lock serializes saves, and each compares If-Match with the version on disk.
      if ((headers['If-Match'] ?? null) !== doc.etag) {
        // The cadence route answers a conflict as the config route does: with config/profile.yml's ConfigRead.
        const current = key === '/api/followups/cadence' ? { kind: doc.kind, path: 'config/profile.yml', raw: '', etag: doc.etag, doc: { followup_cadence: doc.cadence }, parseError: null } : doc;
        return json(409, { error: 'the file changed since you loaded it', current });
      }
      const etag = `${doc.etag}+`;
      // A structured save writes its ops and a raw save its text, so the refetch after it reads the version written, as on the real routes.
      const ops = (body as { ops?: YamlOp[] } | null)?.ops;
      const raw = (body as { raw?: string } | null)?.raw;
      files[key] = { ...doc, etag, ...(ops && 'doc' in doc ? { doc: applyOpsJs(doc.doc, ops) } : {}), ...(typeof raw === 'string' ? { raw } : {}) };
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
  client = qc;
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, child))));
}
/** The mounted app's query client, so a test can play the watcher's refetch after a change on disk. */
let client: QueryClient;
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

  it('after a save with no edit mid-flight, the editor keeps the just-written version, so the next edit is not a false 409 (R17-feat-c-L1-02)', async () => {
    await mountHarness();
    await click(button('Set a')!);
    await click(button('Save')!);
    await until(() => /Saved portals\.yml \(1 change, validated\)/.test(document.body.textContent ?? ''), 'the saved note');
    // The editor shows the version just written, not the pre-save copy.
    expect(labelled('doc')!.textContent).toBe(JSON.stringify({ a: 2, b: 1 }));
    // An edit made right after the save is on the version just written, so it saves without a false conflict.
    await click(button('Set b')!);
    await click(button('Save')!);
    await until(() => writes().length === 2, 'the second save');
    expect(writes()[1]).toEqual(expect.objectContaining({ body: { ops: [{ op: 'set', path: ['b'], value: 3 }] }, headers: expect.objectContaining({ 'If-Match': 'p1+' }) }));
    expect(alerts()).toBe('');
  });
  it('after a save, a later change on disk becomes the base once refetched, so the next edit saves on it without a false 409 (review)', async () => {
    await mountHarness();
    await click(button('Set a')!);
    await click(button('Save')!);
    await until(() => /Saved portals\.yml \(1 change, validated\)/.test(document.body.textContent ?? ''), 'the saved note');
    // Another writer changes the file; the watcher refetches it.
    files['/api/config/portals'] = { ...files['/api/config/portals']!, etag: 'p2', doc: { a: 5, b: 1 } };
    await act(async () => client.invalidateQueries({ queryKey: ['config'] }));
    await until(() => labelled('doc')!.textContent === JSON.stringify({ a: 5, b: 1 }), 'the version on disk');
    await click(button('Set b')!);
    await click(button('Save')!);
    await until(() => writes().length === 2, 'the second save');
    expect(writes()[1]).toEqual(expect.objectContaining({ headers: expect.objectContaining({ 'If-Match': 'p2' }) }));
    await until(() => labelled('pending')!.textContent === '0', 'nothing pending');
    expect(alerts()).toBe('');
  });

  it('a change on disk refetched in the same millisecond the save answered still becomes the base', async () => {
    await mountHarness();
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      await click(button('Set a')!);
      await click(button('Save')!);
      await until(() => /Saved portals\.yml \(1 change, validated\)/.test(document.body.textContent ?? ''), 'the saved note');
      files['/api/config/portals'] = { ...files['/api/config/portals']!, etag: 'p2', doc: { a: 5, b: 1 } };
      await act(async () => client.invalidateQueries({ queryKey: ['config'] }));
      await until(() => labelled('doc')!.textContent === JSON.stringify({ a: 5, b: 1 }), 'the version on disk');
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });

  it('after a save whose refetch fails, the next edit still saves on the version just written (review)', async () => {
    await mountHarness();
    await click(button('Set a')!);
    readsFail = true;
    await click(button('Save')!);
    await until(() => /Saved portals\.yml \(1 change, validated\)/.test(document.body.textContent ?? ''), 'the saved note');
    await until(() => calls.some((c) => c.method === 'GET' && c.url === '/api/config/portals' && calls.indexOf(c) > calls.findIndex((w) => w.method !== 'GET')), 'the failed refetch');
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    await click(button('Set b')!);
    await click(button('Save')!);
    await until(() => writes().length === 2, 'the second save');
    expect(writes()[1]).toEqual(expect.objectContaining({ headers: expect.objectContaining({ 'If-Match': 'p1+' }) }));
  });

  it('a read sent before the save that answers after it does not unpin the version just written (review)', async () => {
    await mountHarness();
    await click(button('Set a')!);
    slowRead = {};
    const stale = slowRead;
    void client.refetchQueries({ queryKey: ['config', 'portals'] });
    await until(() => Boolean(stale.release), 'the slow read reaching the server');
    await click(button('Save')!);
    await until(() => /Saved portals\.yml \(1 change, validated\)/.test(document.body.textContent ?? ''), 'the saved note');
    await act(async () => stale.release!());
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    await click(button('Set b')!);
    await click(button('Save')!);
    await until(() => writes().length === 2, 'the second save');
    expect(writes()[1]).toEqual(expect.objectContaining({ headers: expect.objectContaining({ 'If-Match': 'p1+' }) }));
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
  it('Save blacklist asks once and writes once', async () => {
    files = { '/api/blacklist': { kind: 'ok', path: 'data/blacklist.md', raw: '', etag: 'b1', rows: [], preamble: null, postamble: '', extraColumns: [], columnWarning: null, unkept: [] } };
    const { BlacklistEditor } = await import('@web/features/settings/BlacklistEditor');
    await mount(createElement(BlacklistEditor, {}));
    await type(await until(() => labelled<HTMLInputElement>('Blacklist company or domain'), 'the company field'), 'Globex');
    await click(button('Add row')!);
    const save = button('Save blacklist')!;
    await act(async () => {
      save.click();
      save.click();
    });
    await click(await until(() => button('Write blacklist'), 'the confirm dialog'));
    await until(() => /Blacklist written/.test(document.body.textContent ?? ''), 'the written note');
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(writes()).toHaveLength(1);
    expect(button('Add row')).toBeDefined();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

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

describe('raw YAML editor: a save whose refetch fails (R18-feat-c-L1-01)', () => {
  it('hides the editor until a read after the save succeeds, which shows the written text and saves on its ETag', async () => {
    files = { '/api/config/portals': { key: 'portals', path: 'portals.yml', kind: 'ok', raw: 'a: 1\n', etag: 'p1', doc: { a: 1 }, parseError: null } };
    const { ConfigEditor } = await import('@web/features/settings/RawConfigEditor');
    await mount(createElement(ConfigEditor, { fileKey: 'portals', label: 'portals.yml', validator: 'validate-portals.mjs' }));
    const editor = await until(() => labelled<HTMLTextAreaElement>('portals.yml YAML')?.value === 'a: 1\n' && labelled<HTMLTextAreaElement>('portals.yml YAML'), 'the editor');
    await type(editor, 'a: 2\n');
    readsFail = true;
    await click(button('Validate and save')!);
    await until(() => /Saved portals\.yml/.test(document.body.textContent ?? ''), 'the saved note');
    // The pre-save copy is never editable: the failed read replaces the editor with the load error.
    await until(() => /Could not load/.test(alerts()), 'the load error');
    expect(labelled('portals.yml YAML')).toBeNull();
    readsFail = false;
    await click(button('Retry')!);
    const shown = await until(() => labelled<HTMLTextAreaElement>('portals.yml YAML'), 'the editor back');
    expect(shown.value).toBe('a: 2\n');
    await type(shown, 'a: 3\n');
    await click(button('Validate and save')!);
    await until(() => writes().length === 2, 'the second save');
    expect(writes()[1]).toEqual(expect.objectContaining({ body: { raw: 'a: 3\n' }, headers: expect.objectContaining({ 'If-Match': 'p1+' }) }));
  });
});

describe('cadence and blacklist editors while the post-save refetch is on its way (R18-feat-c-L1-02)', () => {
  it('the cadence form keeps showing the saved value, not the pre-save copy', async () => {
    files = { '/api/followups/cadence': { kind: 'ok', etag: 'c1', cadence: { applied_first_days: 7 }, keys: ['applied_first_days'], parseError: null } };
    const { CadenceForm } = await import('@web/features/settings/ProfileForm');
    await mount(createElement(CadenceForm));
    const field = await until(() => document.querySelector<HTMLInputElement>('#cadence-applied_first_days')?.value === '7' && document.querySelector<HTMLInputElement>('#cadence-applied_first_days'), 'the cadence field');
    await type(field, '9');
    slowRead = {};
    const refetch = slowRead;
    await click(button('Save cadence')!);
    await until(() => /Follow-up cadence saved/.test(document.body.textContent ?? ''), 'the saved note');
    await until(() => Boolean(refetch.release), 'the refetch on its way');
    expect(document.querySelector<HTMLInputElement>('#cadence-applied_first_days')!.value).toBe('9');
    // The read on its way answers the file as written.
    files['/api/followups/cadence']!.cadence = { applied_first_days: 9 };
    await act(async () => refetch.release!());
    await until(() => !document.querySelector<HTMLInputElement>('#cadence-applied_first_days')!.disabled, 'the fields back');
    expect(document.querySelector<HTMLInputElement>('#cadence-applied_first_days')!.value).toBe('9');
  });

  it('after a cadence conflict whose refetch fails, the next save goes on the version the conflict showed, not a second 409 (R35-feat-c-L1-01)', async () => {
    files = { '/api/followups/cadence': { kind: 'ok', etag: 'c1', cadence: { applied_first_days: 7 }, keys: ['applied_first_days'], parseError: null } };
    const { CadenceForm } = await import('@web/features/settings/ProfileForm');
    await mount(createElement(CadenceForm));
    const field = await until(() => document.querySelector<HTMLInputElement>('#cadence-applied_first_days')?.value === '7' && document.querySelector<HTMLInputElement>('#cadence-applied_first_days'), 'the cadence field');
    await type(field, '9');
    // Another writer changes the file, and the reads fail while the conflict is answered.
    files['/api/followups/cadence'] = { ...files['/api/followups/cadence']!, etag: 'c2', cadence: { applied_first_days: 8 } };
    readsFail = true;
    await click(button('Save cadence')!);
    await until(() => writes().length === 1 && button('Retry'), 'the conflict and the failed read');
    readsFail = false;
    await click(button('Retry')!);
    await until(() => document.querySelector<HTMLInputElement>('#cadence-applied_first_days')?.value === '9', 'the form back with the typed value');
    await click(button('Save cadence')!);
    await until(() => /Follow-up cadence saved/.test(document.body.textContent ?? ''), 'the saved note');
    expect(writes().map((w) => w.headers['If-Match'])).toEqual(['c1', 'c2']);
  });

  it('the blacklist keeps showing the written rows, not the pre-save copy', async () => {
    files = { '/api/blacklist': { kind: 'ok', path: 'data/blacklist.md', raw: '', etag: 'b1', rows: [{ company: 'Initech', since: '2026-01-01', scope: 'company', reason: '' }], preamble: null, postamble: '', extraColumns: [], columnWarning: null, unkept: [] } };
    const { BlacklistEditor } = await import('@web/features/settings/BlacklistEditor');
    await mount(createElement(BlacklistEditor, {}));
    await type(await until(() => labelled<HTMLInputElement>('Blacklist company or domain'), 'the company field'), 'Globex');
    await click(button('Add row')!);
    slowRead = {};
    const refetch = slowRead;
    await click(button('Save blacklist')!);
    await click(await until(() => button('Write blacklist'), 'the confirm dialog'));
    await until(() => /Blacklist written/.test(document.body.textContent ?? ''), 'the written note');
    await until(() => Boolean(refetch.release), 'the refetch on its way');
    expect(button('Remove Globex from the blacklist draft')).toBeDefined();
    files['/api/blacklist']!.rows = [{ company: 'Initech', since: '2026-01-01', scope: 'company', reason: '' }, { company: 'Globex', since: '2026-01-01', scope: 'company', reason: '' }];
    await act(async () => refetch.release!());
    await until(() => button('Remove Globex from the blacklist draft')?.disabled === false, 'the editor back');
    expect(button('Remove Globex from the blacklist draft')).toBeDefined();
    expect(button('Discard')!.disabled).toBe(true);
  });
});

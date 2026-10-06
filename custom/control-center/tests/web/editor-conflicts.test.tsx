// Every editor saves against the version its draft started from. A change that lands on disk mid-edit reaches the
// page the way it does in the app (the watcher's data.changed event over SSE, then a refetch); the editor must say
// the file changed and its save must get the server's 409, never overwrite the other change.
import { createElement, Fragment, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Doc = Record<string, unknown> & { etag: string | null };
type Call = { method: string; url: string; body: unknown; headers: Record<string, string> };

/** The server: each GET answers the current version; a PUT or POST whose If-Match is not the current ETag gets the 409 the real routes send. */
let files: Record<string, Doc>;
let calls: Call[];
let host: HTMLElement;
let root: Root;

/** jsdom has no EventSource: this one hands the app's own listener the frames the server would send. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  private listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  constructor(public url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function serve() {
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null, headers });
      const key = url.startsWith('/api/projects/') ? '/api/projects' : url;
      const doc = files[key];
      if (!doc) return json(404, { error: 'not stubbed' });
      if (method === 'GET') return json(200, doc);
      // As server/routes/projects.ts: a PUT or DELETE of an id the current library lacks is a 404 before the ETag is compared.
      const id = url.match(/^\/api\/projects\/([^/?]+)$/)?.[1];
      if (id && (method === 'PUT' || method === 'DELETE') && !(doc.entries as Array<{ id: string }>).some((e) => e.id === id)) return json(404, { error: `no project ${id}` });
      if ((headers['If-Match'] ?? null) !== doc.etag) return json(409, { error: 'the file changed since you loaded it', current: doc });
      const etag = `${doc.etag}-saved`;
      files[key] = { ...doc, etag };
      return json(200, { ok: true, etag, warnings: '' });
    }),
  );
}

/** Another writer changes the file; the watcher's frame reaches the page and the editors refetch. */
async function changeOnDisk(url: string, patch: Partial<Doc>) {
  files[url] = { ...files[url]!, ...patch };
  await act(async () => FakeEventSource.last!.emit('data.changed', { domain: 'config' }));
}

async function mount(child: ReactNode) {
  const { useLiveInvalidation } = await import('@web/lib/sse');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const Live = ({ children }: { children: ReactNode }) => {
    useLiveInvalidation();
    return createElement(Fragment, null, children);
  };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(Live, null, child)))));
}

async function until<T>(fn: () => T | null | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = fn();
    if (v) return v;
    await act(async () => new Promise((r) => setTimeout(r, 20)));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const labelled = <T extends HTMLElement>(label: string) => document.querySelector<T>(`[aria-label="${label}"]`);
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === name);
const alerts = () => [...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? '').join('\n');
const click = (el: HTMLElement) => act(async () => el.click());
const writes = () => calls.filter((c) => c.method !== 'GET');
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  calls = [];
  FakeEventSource.last = null;
  serve();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

describe('cv.md editor (Profile & CV)', () => {
  beforeEach(() => {
    files = { '/api/files/user/cv': { key: 'cv', path: 'cv.md', kind: 'ok', text: '# CV\n', etag: 'c1' } };
  });
  const mountEditor = async () => {
    const { UserFileEditor } = await import('@web/features/profile/ProfilePage');
    await mount(createElement(UserFileEditor, { fileKey: 'cv', label: 'cv.md' }));
    return until(() => labelled<HTMLTextAreaElement>('cv.md contents')?.value === '# CV\n' && labelled<HTMLTextAreaElement>('cv.md contents'), 'the editor');
  };

  it('a change on disk mid-edit shows "changed on disk"; Save sends the draft base ETag, gets the 409 and the conflict pane, and writes nothing', async () => {
    const editor = await mountEditor();
    await type(editor, '# CV\n- typed here\n');
    await changeOnDisk('/api/files/user/cv', { text: '# CV\n- added elsewhere\n', etag: 'c2' });
    await until(() => /cv\.md changed on disk since you started editing/.test(alerts()), 'the changed-on-disk note');
    expect(labelled<HTMLTextAreaElement>('cv.md contents')!.value).toBe('# CV\n- typed here\n');
    await click(button('Save')!);
    await until(() => document.body.textContent?.includes('Current version on disk'), 'the conflict pane');
    expect(writes()).toEqual([expect.objectContaining({ method: 'PUT', url: '/api/files/user/cv', headers: expect.objectContaining({ 'If-Match': 'c1' }) })]);
    expect(files['/api/files/user/cv']).toMatchObject({ text: '# CV\n- added elsewhere\n', etag: 'c2' });
    expect(document.querySelector('pre')?.textContent).toBe('# CV\n- added elsewhere\n');
    // Having seen the current version, saving again is the deliberate overwrite.
    await click(button('Save')!);
    await until(() => writes().length === 2, 'the second save');
    expect(writes()[1]!.headers['If-Match']).toBe('c2');
  });

  it('without a change on disk the save goes through on the loaded ETag and shows no conflict', async () => {
    const editor = await mountEditor();
    await type(editor, '# CV\n- typed here\n');
    await click(button('Save')!);
    await until(() => document.body.textContent?.includes('Saved cv.md'), 'the saved note');
    expect(writes()[0]!.headers['If-Match']).toBe('c1');
    expect(alerts()).toBe('');
  });
});

describe('raw YAML editor (Settings)', () => {
  beforeEach(() => {
    files = { '/api/config/portals': { key: 'portals', path: 'portals.yml', kind: 'ok', raw: 'a: 1\n', etag: 'p1', doc: { a: 1 }, parseError: null } };
  });

  it('a change on disk mid-edit shows "changed on disk" and Save gets the 409 instead of overwriting it', async () => {
    const { ConfigEditor } = await import('@web/features/settings/RawConfigEditor');
    await mount(createElement(ConfigEditor, { fileKey: 'portals', label: 'portals.yml', validator: 'validate-portals.mjs' }));
    const editor = await until(() => labelled<HTMLTextAreaElement>('portals.yml YAML')?.value === 'a: 1\n' && labelled<HTMLTextAreaElement>('portals.yml YAML'), 'the editor');
    await type(editor, 'a: 2\n');
    await changeOnDisk('/api/config/portals', { raw: 'a: 1\nb: elsewhere\n', etag: 'p2', doc: { a: 1, b: 'elsewhere' } });
    await until(() => /portals\.yml changed on disk since you started editing/.test(alerts()), 'the changed-on-disk note');
    expect(labelled<HTMLTextAreaElement>('portals.yml YAML')!.value).toBe('a: 2\n');
    await click(button('Validate and save')!);
    await until(() => /changed on disk since you loaded it/.test(alerts()), 'the conflict note');
    expect(writes()).toEqual([expect.objectContaining({ method: 'PUT', headers: expect.objectContaining({ 'If-Match': 'p1' }) })]);
    expect(files['/api/config/portals']).toMatchObject({ raw: 'a: 1\nb: elsewhere\n', etag: 'p2' });
  });
});

describe('structured editors (useStructuredConfig)', () => {
  beforeEach(() => {
    files = { '/api/config/portals': { key: 'portals', path: 'portals.yml', kind: 'ok', raw: 'a: 1\nlist: [x, y]\n', etag: 'p1', doc: { a: 1, list: ['x', 'y'] }, parseError: null } };
  });

  it('pending ops stay on the version they were made on: a change on disk shows "changed on disk", and Save gets the 409 instead of re-applying them silently', async () => {
    const { useStructuredConfig, EditorNoteView } = await import('@web/features/settings/useStructuredConfig');
    function Harness() {
      const s = useStructuredConfig('portals');
      return createElement(
        'div',
        null,
        createElement('button', { type: 'button', onClick: () => s.addOp({ op: 'delete', path: ['list', 0] }) }, 'Delete first'),
        createElement('button', { type: 'button', onClick: () => s.addOp({ op: 'set', path: ['a'], value: 2 }) }, 'Set a'),
        createElement('button', { type: 'button', onClick: () => void s.save() }, 'Save'),
        createElement('output', { 'aria-label': 'doc' }, JSON.stringify(s.doc)),
        createElement(EditorNoteView, { note: s.note }),
      );
    }
    await mount(createElement(Harness));
    await until(() => labelled('doc')?.textContent === JSON.stringify({ a: 1, list: ['x', 'y'] }), 'the loaded doc');
    await click(button('Delete first')!);
    await click(button('Set a')!);
    expect(labelled('doc')!.textContent).toBe(JSON.stringify({ a: 2, list: ['y'] }));
    // An index-based op made on [x, y] must not quietly delete "new" from the refetched list.
    await changeOnDisk('/api/config/portals', { raw: 'a: 1\nlist: [new, x, y]\n', etag: 'p2', doc: { a: 1, list: ['new', 'x', 'y'] } });
    await until(() => /portals\.yml changed on disk since you started editing/.test(alerts()), 'the changed-on-disk note');
    expect(labelled('doc')!.textContent).toBe(JSON.stringify({ a: 2, list: ['y'] }));
    await click(button('Save')!);
    await until(() => /changed on disk since you loaded it/.test(alerts()), 'the conflict note');
    expect(writes()).toEqual([expect.objectContaining({ method: 'PUT', headers: expect.objectContaining({ 'If-Match': 'p1' }), body: { ops: [{ op: 'delete', path: ['list', 0] }, { op: 'set', path: ['a'], value: 2 }] } })]);
    expect(files['/api/config/portals']).toMatchObject({ etag: 'p2', doc: { a: 1, list: ['new', 'x', 'y'] } });
    // After the 409 the delete by position is not replayed on the new list (it would remove "new", another writer's
    // entry, and bring "x" back); the page says to redo it. The edit by key stays on top of the current version.
    expect(labelled('doc')!.textContent).toBe(JSON.stringify({ a: 2, list: ['new', 'x', 'y'] }));
    expect(alerts()).toMatch(/1 edit to a list item was dropped because the list changed; redo it on the current version/);
    await click(button('Save')!);
    await until(() => writes().length === 2, 'the second save');
    expect(writes()[1]).toEqual(expect.objectContaining({ method: 'PUT', headers: expect.objectContaining({ 'If-Match': 'p2' }), body: { ops: [{ op: 'set', path: ['a'], value: 2 }] } }));
  });

  it('after a 409, a whole-section set whose section another writer filled is dropped, so saving again keeps their items (SW2-tests-02)', async () => {
    const { useStructuredConfig, EditorNoteView } = await import('@web/features/settings/useStructuredConfig');
    function Harness() {
      const s = useStructuredConfig('portals');
      return createElement(
        'div',
        null,
        createElement('button', { type: 'button', onClick: () => s.addOp({ op: 'set', path: ['boards'], value: [] }) }, 'Add boards'),
        createElement('button', { type: 'button', onClick: () => s.addOp({ op: 'insert', path: ['boards'], value: 'mine' }) }, 'Add my board'),
        createElement('button', { type: 'button', onClick: () => s.addOp({ op: 'set', path: ['queries'], value: [] }) }, 'Add queries'),
        createElement('button', { type: 'button', onClick: () => void s.save() }, 'Save'),
        createElement('output', { 'aria-label': 'doc' }, JSON.stringify(s.doc)),
        createElement(EditorNoteView, { note: s.note }),
      );
    }
    await mount(createElement(Harness));
    await until(() => labelled('doc')?.textContent === JSON.stringify({ a: 1, list: ['x', 'y'] }), 'the loaded doc');
    await click(button('Add boards')!);
    await click(button('Add my board')!);
    await click(button('Add queries')!);
    // Another writer adds ten boards meanwhile.
    const theirs = Array.from({ length: 10 }, (_, i) => `board-${i}`);
    await changeOnDisk('/api/config/portals', { raw: 'a: 1\nlist: [x, y]\nboards: [...]\n', etag: 'p2', doc: { a: 1, list: ['x', 'y'], boards: theirs } });
    await until(() => /portals\.yml changed on disk since you started editing/.test(alerts()), 'the changed-on-disk note');
    await click(button('Save')!);
    await until(() => /changed on disk since you loaded it/.test(alerts()), 'the conflict note');
    // The set would replace their ten boards with an empty list; the append and the untouched section stay.
    expect(labelled('doc')!.textContent).toBe(JSON.stringify({ a: 1, list: ['x', 'y'], boards: [...theirs, 'mine'], queries: [] }));
    expect(alerts()).toMatch(/1 edit to a value that also changed on disk was dropped; redo it on the current version/);
    await click(button('Save')!);
    await until(() => writes().length === 2, 'the second save');
    expect(writes()[1]!.body).toEqual({ ops: [{ op: 'insert', path: ['boards'], value: 'mine' }, { op: 'set', path: ['queries'], value: [] }] });
  });
});

describe('projects library form (Profile & CV > Projects)', () => {
  beforeEach(() => {
    files = {
      '/api/projects': {
        path: 'article-digest.md',
        kind: 'ok',
        etag: 'e1',
        validation: { ok: true, errors: [], warnings: [] },
        entries: [{ id: 'event-router', title: 'Event Router', url: null, tagline: null, tags: [], kind: 'project', dates: null, source: null, bullets: ['One.'], line: 1, editProblem: null, inCv: false }],
      },
    };
  });

  it('a change on disk while the form is open shows "changed on disk"; Save sends the ETag the form opened on and gets the 409', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await mount(createElement(ProjectsLibrary));
    await click(await until(() => button('Edit Event Router'), 'the edit button'));
    await type(await until(() => labelled<HTMLInputElement>('Title'), 'the title field'), 'Event Router v2');
    const entries = files['/api/projects']!.entries as Array<Record<string, unknown>>;
    await changeOnDisk('/api/projects', { etag: 'e2', entries: [{ ...entries[0], bullets: ['One.', 'Added elsewhere.'] }] });
    await until(() => /article-digest\.md changed on disk since you opened this form/.test(alerts()), 'the changed-on-disk note');
    await click(button('Save project')!);
    await until(() => /changed on disk since it was loaded/.test(alerts()), 'the conflict message');
    expect(writes()).toEqual([expect.objectContaining({ method: 'PUT', url: '/api/projects/event-router', headers: expect.objectContaining({ 'If-Match': 'e1' }) })]);
    expect(files['/api/projects']!.etag).toBe('e2');
    expect(labelled<HTMLInputElement>('Title')!.value).toBe('Event Router v2');
    // After the 409 the draft is rebased on the version on disk: the title the user changed stays theirs, and the
    // bullet the other writer added (a field the user did not touch) is taken in, so the second save keeps it (SW2-tests-01).
    await click(button('Save project')!);
    await until(() => writes().length === 2, 'the second save');
    expect(writes()[1]!.headers['If-Match']).toBe('e2');
    expect(writes()[1]!.body).toMatchObject({ title: 'Event Router v2', bullets: ['One.', 'Added elsewhere.'] });
  });

  it('when both the user and the other writer changed the bullets, the form keeps the draft and shows the bullets on disk beside it', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await mount(createElement(ProjectsLibrary));
    await click(await until(() => button('Edit Event Router'), 'the edit button'));
    await type(await until(() => labelled<HTMLTextAreaElement>('Bullet 1'), 'the bullet field'), 'One, reworded.');
    const entries = files['/api/projects']!.entries as Array<Record<string, unknown>>;
    await changeOnDisk('/api/projects', { etag: 'e2', entries: [{ ...entries[0], bullets: ['One.', 'Added elsewhere.'] }] });
    await until(() => /changed on disk since you opened this form/.test(alerts()), 'the changed-on-disk note');
    await click(button('Save project')!);
    await until(() => /Bullets changed both here and on disk/.test(alerts()), 'the conflict message');
    expect(labelled<HTMLTextAreaElement>('Bullet 1')!.value).toBe('One, reworded.');
    expect(labelled('Version on disk')!.textContent).toContain('Added elsewhere.');
  });

  it('when another writer renamed the entry (its id comes from the title), the save after the conflict updates it under its new id, never adds a duplicate', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await mount(createElement(ProjectsLibrary));
    await click(await until(() => button('Edit Event Router'), 'the edit button'));
    await type(await until(() => labelled<HTMLInputElement>('Tags'), 'the tags field'), 'kafka');
    const entries = files['/api/projects']!.entries as Array<Record<string, unknown>>;
    await changeOnDisk('/api/projects', { etag: 'e2', entries: [{ ...entries[0], id: 'event-routing', title: 'Event Routing' }] });
    await until(() => /changed on disk since you opened this form/.test(alerts()), 'the changed-on-disk note');
    await click(button('Save project')!);
    await until(() => /renamed on disk to "Event Routing"/.test(alerts()), 'the renamed message');
    expect(labelled<HTMLInputElement>('Title')!.value).toBe('Event Routing');
    await click(button('Save project')!);
    await until(() => writes().length === 2, 'the second save');
    expect(writes()[1]).toEqual(expect.objectContaining({ method: 'PUT', url: '/api/projects/event-routing', headers: expect.objectContaining({ 'If-Match': 'e2' }), body: expect.objectContaining({ title: 'Event Routing', tags: ['kafka'] }) }));
  });

  it('when the entry is gone from disk, a plain Save posts nothing; only "Save as new project" adds the draft', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await mount(createElement(ProjectsLibrary));
    await click(await until(() => button('Edit Event Router'), 'the edit button'));
    await type(await until(() => labelled<HTMLInputElement>('Title'), 'the title field'), 'Event Router v2');
    const other = { id: 'kite-tracker', title: 'Kite Tracker', url: null, tagline: null, tags: [], kind: 'project', dates: null, source: null, bullets: ['Kites.'], line: 1, editProblem: null, inCv: false };
    await changeOnDisk('/api/projects', { etag: 'e2', entries: [other] });
    await until(() => /changed on disk since you opened this form/.test(alerts()), 'the changed-on-disk note');
    await click(button('Save project')!);
    await until(() => /renamed or removed on disk/.test(alerts()), 'the renamed-or-removed message');
    expect(labelled('Entries on disk now')!.textContent).toContain('Kite Tracker');
    expect(button('Save project')!.disabled).toBe(true);
    await click(button('Save project')!);
    expect(writes()).toHaveLength(1);
    await click(button('Save as new project')!);
    await until(() => writes().length === 2, 'the explicit add');
    expect(writes()[1]).toEqual(expect.objectContaining({ method: 'POST', url: '/api/projects', headers: expect.objectContaining({ 'If-Match': 'e2' }), body: expect.objectContaining({ title: 'Event Router v2', bullets: ['One.'] }) }));
  });

  it('when the entry comes back on disk after the save found it gone, the form picks it up again and Save updates it', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await mount(createElement(ProjectsLibrary));
    await click(await until(() => button('Edit Event Router'), 'the edit button'));
    await type(await until(() => labelled<HTMLInputElement>('Title'), 'the title field'), 'Event Router v2');
    const original = files['/api/projects']!.entries;
    // Removed with no watcher event yet (a rewrite in two steps): the save gets the 404 and the form has nothing to update.
    files['/api/projects'] = { ...files['/api/projects']!, etag: 'e2', entries: [] };
    await click(button('Save project')!);
    await until(() => /renamed or removed on disk/.test(alerts()), 'the renamed-or-removed message');
    expect(button('Save project')!.disabled).toBe(true);
    // The second step puts it back, and the watcher's frame refetches the list.
    await changeOnDisk('/api/projects', { etag: 'e3', entries: original });
    await until(() => button('Save project')?.disabled === false, 'Save enabled again');
    expect(button('Save as new project')).toBeUndefined();
    expect(labelled<HTMLInputElement>('Title')!.value).toBe('Event Router v2');
    await click(button('Save project')!);
    await until(() => writes().length === 2, 'the second save');
    expect(writes()[1]).toEqual(expect.objectContaining({ method: 'PUT', url: '/api/projects/event-router', headers: expect.objectContaining({ 'If-Match': 'e3' }) }));
  });

  it('what the user types while the save is on its way is kept when the conflict rebases the draft', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await mount(createElement(ProjectsLibrary));
    await click(await until(() => button('Edit Event Router'), 'the edit button'));
    await type(await until(() => labelled<HTMLInputElement>('Title'), 'the title field'), 'Event Router v2');
    const entries = files['/api/projects']!.entries as Array<Record<string, unknown>>;
    await changeOnDisk('/api/projects', { etag: 'e2', entries: [{ ...entries[0], bullets: ['One.', 'Added elsewhere.'] }] });
    await until(() => /changed on disk since you opened this form/.test(alerts()), 'the changed-on-disk note');
    const real = vi.mocked(fetch).getMockImplementation()!;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (init?.method === 'PUT') await held;
      return real(input, init);
    });
    await click(button('Save project')!);
    await type(labelled<HTMLInputElement>('Dates')!, '2024');
    await act(async () => release());
    await until(() => /changes to this entry are now in the form/.test(alerts()), 'the rebase message');
    expect(labelled<HTMLInputElement>('Dates')!.value).toBe('2024');
    expect(labelled<HTMLInputElement>('Title')!.value).toBe('Event Router v2');
    expect(labelled<HTMLTextAreaElement>('Bullet 2')!.value).toBe('Added elsewhere.');
  });

  it('the conflict message stays when the save is refused (404 for the removed id) before the list refresh moves the form', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await mount(createElement(ProjectsLibrary));
    await click(await until(() => button('Edit Event Router'), 'the edit button'));
    await type(await until(() => labelled<HTMLInputElement>('Title'), 'the title field'), 'Event Router v2');
    // Removed on disk with no watcher event: the list still shows the entry when Save gets the 409.
    files['/api/projects'] = { ...files['/api/projects']!, etag: 'e2', entries: [] };
    await click(button('Save project')!);
    await until(() => /renamed or removed on disk/.test(alerts()), 'the renamed-or-removed message');
    expect(labelled<HTMLInputElement>('Title')!.value).toBe('Event Router v2');
  });

  it('when reloading the library after the conflict fails, the form says so and keeps the draft', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await mount(createElement(ProjectsLibrary));
    await click(await until(() => button('Edit Event Router'), 'the edit button'));
    await type(await until(() => labelled<HTMLInputElement>('Title'), 'the title field'), 'Event Router v2');
    const entries = files['/api/projects']!.entries as Array<Record<string, unknown>>;
    await changeOnDisk('/api/projects', { etag: 'e2', entries: [{ ...entries[0], bullets: ['One.', 'Added elsewhere.'] }] });
    await until(() => /changed on disk since you opened this form/.test(alerts()), 'the changed-on-disk note');
    const real = vi.mocked(fetch).getMockImplementation()!;
    let conflicted = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (conflicted && String(input) === '/api/projects' && (init?.method ?? 'GET') === 'GET') return json(500, { error: 'article-digest.md is unreadable' });
      const res = await real(input, init);
      if (res.status === 409) conflicted = true;
      return res;
    });
    await click(button('Save project')!);
    await until(() => /reloading it failed: .*Try again/.test(alerts()), 'the reload failure message');
    expect(labelled<HTMLInputElement>('Title')!.value).toBe('Event Router v2');
  });
});

describe('blacklist editor (Settings)', () => {
  beforeEach(() => {
    files = { '/api/blacklist': { kind: 'ok', path: 'data/blacklist.md', raw: '', etag: 'b1', rows: [{ company: 'Initech', since: '2026-01-01', scope: 'company', reason: '' }], preamble: null, postamble: '', extraColumns: [] } };
  });

  it('a change on disk while rows are pending shows "changed on disk", and the confirmed save gets the 409 instead of dropping the other change', async () => {
    const { BlacklistEditor } = await import('@web/features/settings/BlacklistEditor');
    await mount(createElement(BlacklistEditor, {}));
    await type(await until(() => labelled<HTMLInputElement>('Blacklist company or domain'), 'the company field'), 'Globex');
    await click(button('Add row')!);
    await changeOnDisk('/api/blacklist', { etag: 'b2', rows: [...(files['/api/blacklist']!.rows as unknown[]), { company: 'Umbrella', since: '2026-02-02', scope: 'company', reason: 'added elsewhere' }] });
    await until(() => /data\/blacklist\.md changed on disk since you started editing/.test(alerts()), 'the changed-on-disk note');
    await click(button('Save blacklist')!);
    await click(await until(() => button('Write blacklist'), 'the confirm dialog'));
    await until(() => /changed on disk; the current rows were reloaded/.test(alerts()), 'the conflict message');
    expect(writes()).toEqual([expect.objectContaining({ method: 'PUT', url: '/api/blacklist', headers: expect.objectContaining({ 'If-Match': 'b1', 'X-CC-Explicit': 'blacklist' }) })]);
    expect((files['/api/blacklist']!.rows as Array<{ company: string }>).map((r) => r.company)).toEqual(['Initech', 'Umbrella']);
  });
});

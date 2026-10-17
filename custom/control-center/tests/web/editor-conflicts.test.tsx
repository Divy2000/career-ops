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

  it('given Save clicked twice before the page re-renders, then one PUT goes out and the save is not shown as a change on disk', async () => {
    const editor = await mountEditor();
    await type(editor, '# CV\n- typed here\n');
    const save = button('Save')!;
    await act(async () => {
      save.click();
      save.click();
    });
    await until(() => document.body.textContent?.includes('Saved cv.md'), 'the saved note');
    expect(writes()).toHaveLength(1);
    expect(alerts()).toBe('');
    expect(document.body.textContent).not.toContain('Current version on disk');
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

describe('follow-up cadence form (Settings > Profile)', () => {
  beforeEach(() => {
    files = { '/api/followups/cadence': { kind: 'ok', etag: 'c1', cadence: { applied_first_days: 7 }, keys: ['applied_first_days'], parseError: null } };
  });

  it('a change on disk mid-edit shows "changed on disk", and Save sends the ETag the edit started from and gets the 409 instead of overwriting it (SW3-tests-07)', async () => {
    const { CadenceForm } = await import('@web/features/settings/ProfileForm');
    await mount(createElement(CadenceForm));
    const field = await until(() => document.querySelector<HTMLInputElement>('#cadence-applied_first_days')?.value === '7' && document.querySelector<HTMLInputElement>('#cadence-applied_first_days'), 'the cadence field');
    await type(field, '9');
    await changeOnDisk('/api/followups/cadence', { etag: 'c2', cadence: { applied_first_days: 5 } });
    await until(() => /changed on disk since you started editing/.test(alerts()), 'the changed-on-disk note');
    await click(button('Save cadence')!);
    await until(() => /nothing was written/.test(alerts()) && writes().length === 1, 'the conflict');
    expect(writes()).toEqual([expect.objectContaining({ method: 'PUT', url: '/api/followups/cadence', headers: expect.objectContaining({ 'If-Match': 'c1' }) })]);
    expect(files['/api/followups/cadence']).toMatchObject({ etag: 'c2', cadence: { applied_first_days: 5 } });
    // The user's value stays in the form; saving again applies it over the version now on disk.
    expect(document.querySelector<HTMLInputElement>('#cadence-applied_first_days')!.value).toBe('9');
    await click(button('Save cadence')!);
    await until(() => writes().length === 2, 'the second save');
    expect(writes()[1]!.headers['If-Match']).toBe('c2');
  });

  it('a second change on disk after the conflict is not overwritten either: the next save is pinned to the version the user was shown', async () => {
    const { CadenceForm } = await import('@web/features/settings/ProfileForm');
    await mount(createElement(CadenceForm));
    const field = await until(() => document.querySelector<HTMLInputElement>('#cadence-applied_first_days')?.value === '7' && document.querySelector<HTMLInputElement>('#cadence-applied_first_days'), 'the cadence field');
    await type(field, '9');
    await changeOnDisk('/api/followups/cadence', { etag: 'c2', cadence: { applied_first_days: 5 } });
    await click(button('Save cadence')!);
    await until(() => writes().length === 1 && /nothing was written/.test(alerts()), 'the first conflict');
    // Another writer changes it again after the user was told about c2, and the page has refetched it.
    const reads = () => calls.filter((c) => c.method === 'GET' && c.url === '/api/followups/cadence').length;
    const before = reads();
    await changeOnDisk('/api/followups/cadence', { etag: 'c3', cadence: { applied_first_days: 3 } });
    await until(() => reads() > before, 'the refetch of c3');
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    await click(button('Save cadence')!);
    await until(() => writes().length === 2, 'the second save');
    expect(writes()[1]!.headers['If-Match']).toBe('c2');
    expect(files['/api/followups/cadence']).toMatchObject({ etag: 'c3', cadence: { applied_first_days: 3 } });
  });
  it('after a successful save, a change on disk during the next edit still shows "changed on disk" (R19-feat-c-L1-01)', async () => {
    const { CadenceForm } = await import('@web/features/settings/ProfileForm');
    await mount(createElement(CadenceForm));
    const field = await until(() => document.querySelector<HTMLInputElement>('#cadence-applied_first_days')?.value === '7' && document.querySelector<HTMLInputElement>('#cadence-applied_first_days'), 'the cadence field');
    await type(field, '9');
    await click(button('Save cadence')!);
    await until(() => writes().length === 1 && /Follow-up cadence saved/.test(host.textContent ?? '') && button('Save cadence')!.disabled, 'the first save');
    await until(() => document.querySelector<HTMLInputElement>('#cadence-applied_first_days')!.disabled === false, 'the form to settle');
    await type(document.querySelector<HTMLInputElement>('#cadence-applied_first_days')!, '11');
    await changeOnDisk('/api/followups/cadence', { etag: 'c9', cadence: { applied_first_days: 4 } });
    await until(() => /changed on disk since you started editing/.test(alerts()), 'the changed-on-disk note');
    // The old success note no longer claims the current edits were saved.
    expect(host.textContent).not.toMatch(/Follow-up cadence saved/);
  });
  it('a successful save never reports its own write as a change on disk, even while other follow-up data refreshes', async () => {
    const { CadenceForm } = await import('@web/features/settings/ProfileForm');
    const { useQuery } = await import('@tanstack/react-query');
    // Another follow-up view on the page, whose refresh after the save is slow.
    let release!: () => void;
    let slow = false;
    function Followups() {
      useQuery({ queryKey: ['followups', 'list'], queryFn: () => (slow ? new Promise((r) => (release = () => r({}))) : Promise.resolve({})) });
      return null;
    }
    await mount(createElement(Fragment, null, createElement(CadenceForm), createElement(Followups)));
    const field = await until(() => document.querySelector<HTMLInputElement>('#cadence-applied_first_days')?.value === '7' && document.querySelector<HTMLInputElement>('#cadence-applied_first_days'), 'the cadence field');
    await type(field, '9');
    slow = true;
    const seen: string[] = [];
    const watch = new MutationObserver(() => seen.push(alerts()));
    watch.observe(document.body, { subtree: true, childList: true, characterData: true });
    await click(button('Save cadence')!);
    await until(() => writes().length === 1 && calls.filter((c) => c.url === '/api/followups/cadence' && c.method === 'GET').length >= 2, 'the save and its refetch');
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    seen.push(alerts());
    await act(async () => release());
    watch.disconnect();
    expect(seen.filter((a) => /changed on disk/.test(a))).toEqual([]);
  });

  it('a change on disk while a refused value is being corrected still shows "changed on disk"', async () => {
    const { CadenceForm } = await import('@web/features/settings/ProfileForm');
    await mount(createElement(CadenceForm));
    const field = await until(() => document.querySelector<HTMLInputElement>('#cadence-applied_first_days')?.value === '7' && document.querySelector<HTMLInputElement>('#cadence-applied_first_days'), 'the cadence field');
    await type(field, '-1');
    await click(button('Save cadence')!);
    await until(() => /whole numbers of days/.test(alerts()), 'the refused value');
    await type(field, '9');
    await changeOnDisk('/api/followups/cadence', { etag: 'c9', cadence: { applied_first_days: 4 } });
    await until(() => /changed on disk since you started editing/.test(alerts()), 'the changed-on-disk note');
    expect(writes()).toEqual([]);
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

describe('projects library: typing while a save is on its way (R23-feat-b-L1-01)', () => {
  const entry = { id: 'event-router', title: 'Event Router', url: null, tagline: null, tags: [], kind: 'project', dates: null, source: null, bullets: ['One.'], line: 1, editProblem: null, inCv: false };
  beforeEach(() => {
    files = { '/api/projects': { path: 'article-digest.md', kind: 'ok', etag: 'e1', validation: { ok: true, errors: [], warnings: [] }, entries: [entry] } };
  });

  /** Holds the first write until released and, as the real routes do, writes its body into the library (the id comes from the title; a POST answers with it). */
  function holdFirstPutAndApply(opts: { otherWriteAfterPost?: boolean } = {}) {
    const real = vi.mocked(fetch).getMockImplementation()!;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    let first = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const method = init?.method;
      if (method !== 'PUT' && method !== 'POST') return real(input, init);
      if (first) {
        first = false;
        await held;
      }
      const res = await real(input, init);
      if (!res.ok) return res;
      const sent = JSON.parse(String(init!.body)) as typeof entry;
      // The library stores each field on one line, as the real serializer does.
      const oneLine = (v: string) => v.replace(/\s+/g, ' ').trim();
      const body = { ...sent, title: oneLine(sent.title), tags: sent.tags.map(oneLine), bullets: sent.bullets.map(oneLine) };
      const savedId = body.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const doc = files['/api/projects']!;
      const list = doc.entries as Array<typeof entry>;
      if (method === 'POST') {
        doc.entries = [...list, { ...entry, ...body, id: savedId }];
        const answer = { ...((await res.json()) as object), id: savedId };
        if (opts.otherWriteAfterPost) doc.etag = 'e-other';
        return json(200, answer);
      }
      const id = String(input).split('/').pop();
      doc.entries = list.map((e) => (e.id === id ? { ...e, ...body, id: savedId } : e));
      return res;
    });
    return () => act(async () => release());
  }

  it('given a save on its way, when the user edits the title meanwhile, then the form stays open with that edit and the next save updates the saved version', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await mount(createElement(ProjectsLibrary));
    await click(await until(() => button('Edit Event Router'), 'the edit button'));
    await type(await until(() => labelled<HTMLTextAreaElement>('Bullet 1'), 'the bullet field'), 'One, reworded.');
    const release = holdFirstPutAndApply();
    await click(button('Save project')!);
    await type(labelled<HTMLInputElement>('Title')!, 'Event Router v2');
    await release();
    await until(() => writes().length === 1 && button('Save project')?.disabled !== true, 'the first save to finish');
    expect(labelled<HTMLInputElement>('Title')?.value).toBe('Event Router v2');
    expect(labelled<HTMLTextAreaElement>('Bullet 1')!.value).toBe('One, reworded.');
    expect(alerts()).toBe('');
    await click(button('Save project')!);
    await until(() => writes().length === 2, 'the second save');
    expect(writes()[1]).toEqual(expect.objectContaining({ method: 'PUT', url: '/api/projects/event-router', headers: expect.objectContaining({ 'If-Match': 'e1-saved' }), body: expect.objectContaining({ title: 'Event Router v2', bullets: ['One, reworded.'] }) }));
  });

  it('given a save that renames the entry, when the user edits a bullet meanwhile, then the next save updates the entry under its new id', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await mount(createElement(ProjectsLibrary));
    await click(await until(() => button('Edit Event Router'), 'the edit button'));
    await type(await until(() => labelled<HTMLInputElement>('Title'), 'the title field'), 'Event Routing');
    const release = holdFirstPutAndApply();
    await click(button('Save project')!);
    await type(labelled<HTMLTextAreaElement>('Bullet 1')!, 'One, reworded.');
    await act(async () => labelled<HTMLTextAreaElement>('Bullet 1')!.focus());
    await release();
    await until(() => writes().length === 1 && button('Save project')?.disabled !== true, 'the first save to finish');
    expect(labelled<HTMLTextAreaElement>('Bullet 1')?.value).toBe('One, reworded.');
    // The form moved to the renamed entry's row; the field being typed in keeps the focus.
    expect(document.activeElement).toBe(labelled('Bullet 1'));
    await click(button('Save project')!);
    await until(() => writes().length === 2, 'the second save');
    expect(writes()[1]).toEqual(expect.objectContaining({ method: 'PUT', url: '/api/projects/event-routing', headers: expect.objectContaining({ 'If-Match': 'e1-saved' }), body: expect.objectContaining({ title: 'Event Routing', bullets: ['One, reworded.'] }) }));
  });

  it('given a renaming save whose bullet the library stores normalized, when the user edits the title meanwhile, then the next save still finds the entry under its new id', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await mount(createElement(ProjectsLibrary));
    await click(await until(() => button('Edit Event Router'), 'the edit button'));
    await type(await until(() => labelled<HTMLInputElement>('Title'), 'the title field'), 'Event Routing');
    await type(labelled<HTMLTextAreaElement>('Bullet 1')!, 'Built   the API.');
    const release = holdFirstPutAndApply();
    await click(button('Save project')!);
    await type(labelled<HTMLInputElement>('Title')!, 'Event Routing v2');
    await release();
    await until(() => writes().length === 1 && button('Save project')?.disabled !== true, 'the first save to finish');
    expect(labelled<HTMLInputElement>('Title')?.value).toBe('Event Routing v2');
    await click(button('Save project')!);
    await until(() => writes().length === 2, 'the second save');
    expect(writes()[1]).toEqual(expect.objectContaining({ method: 'PUT', url: '/api/projects/event-routing', headers: expect.objectContaining({ 'If-Match': 'e1-saved' }), body: expect.objectContaining({ title: 'Event Routing v2' }) }));
  });

  it('given a new project saving, when the user edits it meanwhile, then the form stays open on the added entry and the next save updates it', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await mount(createElement(ProjectsLibrary));
    await click(await until(() => button('Add project')?.disabled === false && button('Add project'), 'the add button'));
    await type(await until(() => labelled<HTMLInputElement>('Title'), 'the title field'), 'Kite Tracker');
    await type(labelled<HTMLTextAreaElement>('Bullet 1')!, 'Tracks   kites.');
    const release = holdFirstPutAndApply();
    await click(button('Save project')!);
    await type(labelled<HTMLInputElement>('Dates')!, '2024');
    await release();
    await until(() => writes().length === 1 && button('Save project')?.disabled !== true, 'the first save to finish');
    expect(labelled<HTMLInputElement>('Dates')?.value).toBe('2024');
    await click(button('Save project')!);
    await until(() => writes().length === 2, 'the second save');
    expect(writes()[1]).toEqual(expect.objectContaining({ method: 'PUT', url: '/api/projects/kite-tracker', headers: expect.objectContaining({ 'If-Match': 'e1-saved' }), body: expect.objectContaining({ title: 'Kite Tracker', dates: '2024' }) }));
  });

  it('given a new project saving, when another write lands before the list reloads, then the next save updates the added entry instead of adding it twice', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await mount(createElement(ProjectsLibrary));
    await click(await until(() => button('Add project')?.disabled === false && button('Add project'), 'the add button'));
    await type(await until(() => labelled<HTMLInputElement>('Title'), 'the title field'), 'Kite Tracker');
    await type(labelled<HTMLTextAreaElement>('Bullet 1')!, 'Tracks kites.');
    const release = holdFirstPutAndApply({ otherWriteAfterPost: true });
    await click(button('Save project')!);
    await type(labelled<HTMLInputElement>('Dates')!, '2024');
    await release();
    await until(() => writes().length === 1 && button('Save project')?.disabled !== true, 'the first save to finish');
    await click(button('Save project')!);
    await until(() => writes().length === 2, 'the second save');
    expect(writes()[1]).toEqual(expect.objectContaining({ method: 'PUT', url: '/api/projects/kite-tracker' }));
  });

  it('given the user typing in a field while a new project saves, when the form moves into the list, then that field keeps the focus and caret', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await mount(createElement(ProjectsLibrary));
    await click(await until(() => button('Add project')?.disabled === false && button('Add project'), 'the add button'));
    await type(await until(() => labelled<HTMLInputElement>('Title'), 'the title field'), 'Kite Tracker');
    await type(labelled<HTMLTextAreaElement>('Bullet 1')!, 'Tracks kites.');
    const release = holdFirstPutAndApply();
    await click(button('Save project')!);
    const dates = labelled<HTMLInputElement>('Dates')!;
    await type(dates, '2024');
    await act(async () => {
      dates.focus();
      dates.setSelectionRange(2, 2);
    });
    await release();
    await until(() => writes().length === 1 && button('Save project')?.disabled !== true, 'the first save to finish');
    expect(document.querySelector('.project-row--editing')).not.toBeNull();
    const focused = document.activeElement as HTMLInputElement;
    expect(focused.getAttribute('aria-label')).toBe('Dates');
    expect(focused).toBe(labelled('Dates'));
    expect([focused.selectionStart, focused.selectionEnd]).toEqual([2, 2]);
  });

  it('given the Kind menu focused while a new project saves, when the form moves into the list, then the menu keeps the focus', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await mount(createElement(ProjectsLibrary));
    await click(await until(() => button('Add project')?.disabled === false && button('Add project'), 'the add button'));
    await type(await until(() => labelled<HTMLInputElement>('Title'), 'the title field'), 'Kite Tracker');
    await type(labelled<HTMLTextAreaElement>('Bullet 1')!, 'Tracks kites.');
    const release = holdFirstPutAndApply();
    await click(button('Save project')!);
    await type(labelled<HTMLInputElement>('Dates')!, '2024');
    await act(async () => labelled<HTMLSelectElement>('Kind')!.focus());
    await release();
    await until(() => writes().length === 1 && button('Save project')?.disabled !== true, 'the first save to finish');
    expect(document.querySelector('.project-row--editing')).not.toBeNull();
    expect(document.activeElement).toBe(labelled('Kind'));
  });

  it('given a field the library stores normalized, when the save that sent it finishes mid-edit, then the form shows the stored value and a later conflict does not name that field', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await mount(createElement(ProjectsLibrary));
    await click(await until(() => button('Add project')?.disabled === false && button('Add project'), 'the add button'));
    await type(await until(() => labelled<HTMLInputElement>('Title'), 'the title field'), 'Kite Tracker');
    await type(labelled<HTMLTextAreaElement>('Bullet 1')!, 'Tracks   kites.');
    const release = holdFirstPutAndApply();
    await click(button('Save project')!);
    await type(labelled<HTMLInputElement>('Dates')!, '2024');
    await release();
    await until(() => writes().length === 1 && button('Save project')?.disabled !== true, 'the first save to finish');
    expect(labelled<HTMLTextAreaElement>('Bullet 1')!.value).toBe('Tracks kites.');
    const entries = files['/api/projects']!.entries as Array<{ id: string; bullets: string[] }>;
    await changeOnDisk('/api/projects', { etag: 'e3', entries: entries.map((e) => (e.id === 'kite-tracker' ? { ...e, bullets: ['Tracks kites.', 'Added elsewhere.'] } : e)) });
    await until(() => /changed on disk since you opened this form/.test(alerts()), 'the changed-on-disk note');
    await click(button('Save project')!);
    await until(() => /changed on disk since it was loaded/.test(alerts()), 'the conflict message');
    expect(alerts()).not.toMatch(/changed both here and on disk/);
    expect(labelled<HTMLTextAreaElement>('Bullet 2')!.value).toBe('Added elsewhere.');
    expect(labelled<HTMLInputElement>('Dates')!.value).toBe('2024');
  });

  it('given a save on its way, when nothing is typed meanwhile, then the form closes on success', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await mount(createElement(ProjectsLibrary));
    await click(await until(() => button('Edit Event Router'), 'the edit button'));
    await type(await until(() => labelled<HTMLInputElement>('Title'), 'the title field'), 'Event Routing');
    await click(button('Save project')!);
    await until(() => labelled('Title') === null, 'the form to close');
    expect(writes()).toHaveLength(1);
  });
});

describe('projects library: a save still on its way after Cancel (R20-feat-b-L1-01)', () => {
  const entry = (id: string, title: string) => ({ id, title, url: null, tagline: null, tags: [], kind: 'project', dates: null, source: null, bullets: ['One.'], line: 1, editProblem: null, inCv: false });
  beforeEach(() => {
    files = { '/api/projects': { path: 'article-digest.md', kind: 'ok', etag: 'e1', validation: { ok: true, errors: [], warnings: [] }, entries: [entry('event-router', 'Event Router'), entry('kite-tracker', 'Kite Tracker')] } };
  });

  /** Saves entry A with its PUT held and an answer chosen by the test, cancels A, then opens B and types into it. */
  async function cancelASaveThenEditB(answer: (real: () => Promise<Response>) => Promise<Response>) {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await mount(createElement(ProjectsLibrary));
    await click(await until(() => button('Edit Event Router'), 'the edit button'));
    await type(await until(() => labelled<HTMLInputElement>('Title'), 'the title field'), 'Event Router v2');
    const real = vi.mocked(fetch).getMockImplementation()!;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    let answered = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (init?.method !== 'PUT' || answered) return real(input, init);
      await held;
      answered = true;
      return answer(() => real(input, init));
    });
    await click(button('Save project')!);
    await click(button('Cancel')!);
    await click(await until(() => (button('Edit Kite Tracker')?.disabled === false ? button('Edit Kite Tracker') : undefined), 'the edit button for B'));
    await type(await until(() => labelled<HTMLInputElement>('Dates'), 'the dates field of B'), '2024');
    await act(async () => release());
    await until(() => answered, 'the answer to the PUT of A');
    // Lets the late answer and any refetch it triggers settle.
    await act(async () => new Promise((r) => setTimeout(r, 100)));
  }

  it('given A saved then cancelled, when its PUT succeeds while B is open, then B stays open with its edits', async () => {
    await cancelASaveThenEditB((real) => real());
    expect(labelled<HTMLInputElement>('Title')?.value).toBe('Kite Tracker');
    expect(labelled<HTMLInputElement>('Dates')?.value).toBe('2024');
  });

  it('given A saved then cancelled, when its PUT is refused with 422, then A\'s errors never show on B', async () => {
    await cancelASaveThenEditB(async () => json(422, { errors: ['A title problem from the first form'] }));
    expect(labelled<HTMLInputElement>('Title')?.value).toBe('Kite Tracker');
    expect(alerts()).not.toMatch(/A title problem from the first form/);
  });

  it('given A saved then cancelled, when its PUT gets the 409, then B shows no conflict and keeps the version it opened on', async () => {
    // The 409 means another writer moved the file on: the server is at e2 by the time it answers.
    await cancelASaveThenEditB(async () => {
      files['/api/projects'] = { ...files['/api/projects']!, etag: 'e2' };
      return json(409, { error: 'the file changed since you loaded it' });
    });
    expect(labelled<HTMLInputElement>('Title')?.value).toBe('Kite Tracker');
    expect(alerts()).not.toMatch(/changed on disk since it was loaded/);
    await click(button('Save project')!);
    await until(() => writes().length === 1, 'the save of B');
    expect(writes()[0]).toEqual(expect.objectContaining({ method: 'PUT', url: '/api/projects/kite-tracker', headers: expect.objectContaining({ 'If-Match': 'e1' }) }));
  });

  it('given A cancelled while its conflict reload is on its way, when that reload answers after a newer version loaded, then the list keeps the newer version', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await mount(createElement(ProjectsLibrary));
    await click(await until(() => button('Edit Event Router'), 'the edit button'));
    await type(await until(() => labelled<HTMLInputElement>('Title'), 'the title field'), 'Event Router v2');
    // Another writer moved the file on without a watcher event yet: A's save gets the 409 and reloads the library.
    files['/api/projects'] = { ...files['/api/projects']!, etag: 'e2' };
    const real = vi.mocked(fetch).getMockImplementation()!;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    let conflicted = false;
    let reloadHeld = false;
    let reloaded = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const res = await real(input, init);
      if (res.status === 409) conflicted = true;
      else if (conflicted && !reloadHeld && String(input) === '/api/projects' && (init?.method ?? 'GET') === 'GET') {
        reloadHeld = true;
        await held;
        reloaded = true;
      }
      return res;
    });
    await click(button('Save project')!);
    await until(() => reloadHeld, 'the conflict reload of A');
    await click(button('Cancel')!);
    const entries = files['/api/projects']!.entries as Array<Record<string, unknown>>;
    await changeOnDisk('/api/projects', { etag: 'e3', entries: [...entries, { ...entries[0], id: 'third-thing', title: 'Third Thing' }] });
    await until(() => button('Edit Third Thing'), 'the newer version in the list');
    await act(async () => release());
    await until(() => reloaded, 'the late reload of A');
    await act(async () => new Promise((r) => setTimeout(r, 100)));
    expect(button('Edit Third Thing')).toBeDefined();
  });

  it('given a form whose conflict reload is on its way, when that reload answers after a newer version loaded, then the form rebases on the newer version', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await mount(createElement(ProjectsLibrary));
    await click(await until(() => button('Edit Event Router'), 'the edit button'));
    await type(await until(() => labelled<HTMLInputElement>('Title'), 'the title field'), 'Event Router v2');
    files['/api/projects'] = { ...files['/api/projects']!, etag: 'e2' };
    const real = vi.mocked(fetch).getMockImplementation()!;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    let conflicted = false;
    let reloadHeld = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const res = await real(input, init);
      if (res.status === 409) conflicted = true;
      else if (conflicted && !reloadHeld && String(input) === '/api/projects' && (init?.method ?? 'GET') === 'GET') {
        reloadHeld = true;
        await held;
      }
      return res;
    });
    await click(button('Save project')!);
    await until(() => reloadHeld, 'the conflict reload');
    const entries = files['/api/projects']!.entries as Array<Record<string, unknown>>;
    await changeOnDisk('/api/projects', { etag: 'e3', entries: [...entries, { ...entries[0], id: 'third-thing', title: 'Third Thing' }] });
    await until(() => button('Edit Third Thing'), 'the newer version in the list');
    await act(async () => release());
    await until(() => /changed on disk since it was loaded/.test(alerts()), 'the rebase message');
    expect(button('Edit Third Thing')).toBeDefined();
    await click(button('Save project')!);
    await until(() => writes().length === 2, 'the second save');
    expect(writes()[1]!.headers['If-Match']).toBe('e3');
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

// An editor whose file does not exist yet is the way to create it: the blacklist (opt-in, never auto-populated),
// interview-prep/story-bank.md and modes/_custom.md, a missing portals.yml or profile.yml, the follow-up cadence
// and the projects library. Each server reads an absent file as kind 'missing' and takes a first write with no If-Match,
// so each editor shows its inputs instead of a "File missing" card (SW3-web-b-01).
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '@web/components/ConfirmDialog';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
type Sent = { method: string; url: string; body: unknown; headers: Record<string, string> };
let sent: Sent[];

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const MISSING: Record<string, unknown> = {
  '/api/blacklist': { kind: 'missing', path: 'data/blacklist.md', raw: '', etag: null, rows: [], preamble: null, postamble: '', extraColumns: [] },
  '/api/files/user/storyBank': { key: 'storyBank', path: 'interview-prep/story-bank.md', kind: 'missing', text: '', etag: null },
  '/api/config/portals': { key: 'portals', path: 'portals.yml', kind: 'missing', raw: '', etag: null, doc: null, parseError: null },
  '/api/followups/cadence': { kind: 'missing', etag: null, cadence: {}, keys: ['applied_first_days'], parseError: null },
  '/api/projects': { path: 'article-digest.md', kind: 'missing', etag: null, entries: [], validation: { ok: true, errors: [], warnings: [] } },
};

/** Mounts an editor and waits until its read has landed: no skeleton left and `ready` showing. */
async function mount(child: ReactNode, ready: () => unknown, what: string) {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        sent.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null, headers: (init?.headers ?? {}) as Record<string, string> });
        return new Response(JSON.stringify({ ok: true, etag: 'new' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const body = MISSING[url];
      return new Response(JSON.stringify(body ?? { error: 'not stubbed' }), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, child))));
  await until(() => !host.querySelector('.skeleton') && ready(), what);
}
const labelled = <T extends HTMLElement>(label: string) => document.querySelector<T>(`[aria-label="${label}"]`);
const button = (name: string) => until(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === name && !b.disabled), `an enabled ${name} button`);
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const click = (el: HTMLElement) => act(async () => el.click());

describe('editors for a file that does not exist yet', () => {
  it('the blacklist editor offers the add-row form, prefilled from the link, and Save creates the file', async () => {
    const { BlacklistEditor } = await import('@web/features/settings/BlacklistEditor');
    await mount(createElement(BlacklistEditor, { prefillCompany: 'Acme' }), () => labelled('Blacklist company or domain'), 'the add-row form');
    expect(host.textContent).not.toContain('File missing');
    expect(labelled<HTMLInputElement>('Blacklist company or domain')!.value).toBe('Acme');
    await click(await button('Add row'));
    await click(await button('Save blacklist'));
    await click(await until(() => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === 'Write blacklist'), 'the Write blacklist confirm'));
    await until(() => sent.length > 0, 'the write');
    expect(sent).toEqual([expect.objectContaining({ method: 'PUT', url: '/api/blacklist', body: expect.objectContaining({ rows: [expect.objectContaining({ company: 'Acme' })] }) })]);
    expect(sent[0]!.headers['If-Match']).toBeUndefined();
  });

  it('a raw text file (story-bank.md) gets a textarea and Save writes it with no If-Match', async () => {
    const { UserFileEditor } = await import('@web/features/profile/ProfilePage');
    await mount(createElement(UserFileEditor, { fileKey: 'storyBank', label: 'interview-prep/story-bank.md' }), () => host.textContent?.includes('not created yet'), 'the missing story-bank.md read');
    await type(labelled<HTMLTextAreaElement>('interview-prep/story-bank.md contents')!, '# Stories\n');
    await click(await button('Save'));
    await until(() => sent.length > 0, 'the write');
    expect(sent).toEqual([expect.objectContaining({ method: 'PUT', url: '/api/files/user/storyBank', body: { text: '# Stories\n' } })]);
    expect(sent[0]!.headers['If-Match']).toBeUndefined();
  });

  it('the raw YAML editor gets its textarea for a missing portals.yml', async () => {
    const { ConfigEditor } = await import('@web/features/settings/RawConfigEditor');
    await mount(createElement(ConfigEditor, { fileKey: 'portals', label: 'portals.yml', validator: 'validate-portals.mjs' }), () => host.textContent?.includes('not created yet'), 'the missing portals.yml read');
    expect(labelled('portals.yml YAML')).not.toBeNull();
  });

  it('the cadence form stays a form, with its "saving creates it" note', async () => {
    const { CadenceForm } = await import('@web/features/settings/ProfileForm');
    await mount(createElement(CadenceForm), () => host.textContent?.includes('config/profile.yml is missing'), 'the missing profile read');
    expect(host.textContent).toContain('saving creates it with just these keys');
    expect(document.querySelector('#cadence-applied_first_days')).not.toBeNull();
  });

  it('Add project opens its form for a missing article-digest.md, and Cancel closes it', async () => {
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await mount(createElement(ProjectsLibrary), () => host.textContent?.includes('No article-digest.md yet'), 'the missing article-digest.md read');
    await click(await button('Add project'));
    expect(document.querySelector('form[aria-label="Add a project"]')).not.toBeNull();
    await click(await button('Cancel'));
    expect(document.querySelector('form[aria-label="Add a project"]')).toBeNull();
    expect((await button('Add project')).disabled).toBe(false);
  });
});

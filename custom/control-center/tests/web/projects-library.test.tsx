import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectsRead } from '@shared/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const READ: ProjectsRead = {
  path: 'article-digest.md',
  kind: 'ok',
  etag: 'e1',
  validation: { ok: true, errors: [], warnings: [] },
  entries: [
    { id: 'event-router', title: 'Event Router', url: 'https://github.com/alex-example/event-router', tagline: null, tags: ['python', 'kafka'], kind: 'project', dates: null, bullets: ['One.', 'Two.'], line: 5, inCv: true },
    { id: 'ranking-notes', title: 'Ranking Notes', url: null, tagline: null, tags: [], kind: 'article', dates: null, bullets: ['Wrote it.'], line: 12, inCv: false },
  ],
};

type Call = { method: string; url: string; body: unknown; headers: Record<string, string> };
let calls: Call[];
let putResponse: { status: number; body: unknown };
let host: HTMLElement;
let root: Root;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function mount() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url === '/api/projects' && method === 'GET') return json(200, READ);
      if (url.startsWith('/api/projects/') && method === 'PUT') return json(putResponse.status, putResponse.body);
      if (url.startsWith('/api/files/user/')) return json(200, { key: 'cv', path: 'cv.md', kind: 'ok', text: '# CV\n', etag: 'c1' });
      return json(404, { error: 'not stubbed' });
    }),
  );
  const { ProfilePage } = await import('@web/features/profile/ProfilePage');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(ProfilePage)))));
}

async function until<T>(fn: () => T | null | undefined, what: string): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const v = fn();
    if (v) return v;
    await act(async () => new Promise((r) => setTimeout(r, 20)));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const byRole = (role: string, name: string) => [...host.querySelectorAll<HTMLElement>(`[role="${role}"], ${role === 'button' ? 'button' : role === 'tab' ? '[role=tab]' : role}`)].find((el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim() === name);
const labelled = <T extends HTMLElement>(label: string) => host.querySelector<T>(`[aria-label="${label}"]`);
const click = (el: HTMLElement) => act(async () => el.click());
const type = (el: HTMLInputElement, value: string) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

beforeEach(() => {
  document.body.innerHTML = '';
  putResponse = { status: 200, body: { ok: true, etag: 'e2', id: 'event-router', warnings: [] } };
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

describe('Profile page tabs', () => {
  it('shows a Projects tab next to CV, then More files', async () => {
    await mount();
    const tabs = [...host.querySelectorAll('[role="tablist"][aria-label="Profile sections"] [role="tab"]')].map((t) => t.textContent?.trim());
    expect(tabs).toEqual(['CV', 'Projects', 'More files']);
  });
});

describe('Projects library tab', () => {
  it('lists each entry with its badges: in CV, kind, bullet count and link host', async () => {
    await mount();
    await click(byRole('tab', 'Projects')!);
    const list = await until(() => labelled<HTMLUListElement>('Projects in the library'), 'the list');
    await until(() => list.querySelectorAll(':scope > li').length === 2 || null, 'two entries');
    const [router, notes] = [...list.querySelectorAll(':scope > li')].map((li) => li.textContent ?? '');
    expect(router).toContain('Event Router');
    expect(router).toContain('In CV');
    expect(router).toContain('2 bullets');
    expect(router).toContain('github.com');
    expect(notes).toContain('Article');
    expect(notes).toContain('1 bullet');
  });

  it('given a 422 on save, shows the server errors and keeps the draft', async () => {
    putResponse = { status: 422, body: { error: 'the library would not validate; nothing written', errors: ['duplicate title: "Event Router" (line 5) and "Ranking Notes" (line 12)'] } };
    await mount();
    await click(byRole('tab', 'Projects')!);
    await until(() => byRole('button', 'Edit Event Router'), 'the edit button');
    await click(byRole('button', 'Edit Event Router')!);
    const title = await until(() => labelled<HTMLInputElement>('Title'), 'the title field');
    await type(title, 'Ranking Notes');
    await click(byRole('button', 'Save project')!);
    const alert = await until(() => host.querySelector<HTMLElement>('form [role="alert"]'), 'the error');
    expect(alert.textContent).toContain('duplicate title');
    expect(labelled<HTMLInputElement>('Title')!.value).toBe('Ranking Notes');
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('/api/projects/event-router');
    expect(put.headers['If-Match']).toBe('e1');
    expect(put.body).toMatchObject({ title: 'Ranking Notes', bullets: ['One.', 'Two.'] });
  });
});

// The unsaved-changes guard covers the import drafts on Profile & CV, and every way of leaving: a tab, browser Back
// (a Settings tab is a search param, so history moves it) and a sidebar link (SW4-web-b-01).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserHistory, createMemoryHistory, createRootRoute, createRoute, createRouter, type AnyRouter } from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '@web/components/ConfirmDialog';
import { SETTINGS_TABS, SettingsPage } from '@web/features/settings/SettingsPage';
import { ProfilePage } from '@web/features/profile/ProfilePage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let router: AnyRouter;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const READS: Record<string, unknown> = {
  '/api/blacklist': { kind: 'ok', path: 'data/blacklist.md', raw: '', etag: 'b1', rows: [], preamble: null, postamble: '', extraColumns: [] },
  '/api/config/portals': { key: 'portals', path: 'portals.yml', kind: 'ok', raw: 'a: 1\n', etag: 'p1', doc: { a: 1 }, parseError: null },
  '/api/files/user/cv': { key: 'cv', path: 'cv.md', kind: 'ok', text: '# CV\n', etag: 'c1' },
  '/api/projects': { path: 'article-digest.md', kind: 'ok', etag: 'e1', entries: [], validation: { ok: true, errors: [], warnings: [] } },
};

/** Back and Forward are guarded through the browser's popstate (memory history does not ask blockers on Back). */
async function open(entry: string, browser = false) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => json(READS[url.split('?')[0]!] ?? [])));
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const rootRoute = createRootRoute();
  const settings = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage, validateSearch: (s: Record<string, unknown>) => ({ tab: (SETTINGS_TABS as readonly string[]).includes(String(s.tab)) ? s.tab : 'portals' }) });
  const profile = createRoute({ getParentRoute: () => rootRoute, path: '/profile', component: ProfilePage });
  const runs = createRoute({ getParentRoute: () => rootRoute, path: '/runs', component: () => createElement('p', null, 'Runs page') });
  if (browser) window.history.replaceState(null, '', entry);
  router = createRouter({ routeTree: rootRoute.addChildren([settings, profile, runs]), history: browser ? createBrowserHistory() : createMemoryHistory({ initialEntries: [entry] }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(RouterProvider, { router })))));
  await settle();
}
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const settle = () => act(async () => new Promise((r) => setTimeout(r, 40)));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const inDialog = (name: string) => [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === name)!;
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === name)!;
const tab = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent?.trim() === name)!;
const click = async (el: HTMLElement) => {
  await act(async () => el.click());
  await settle();
};
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the unsaved-changes guard', () => {
  it('asks before a Profile tab drops a CV import draft', async () => {
    await open('/profile');
    await type(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="CV markdown"]')!, '# Imported CV');
    await click(tab('Projects'));
    expect(dialog()?.textContent).toContain('the CV import');
    await click(inDialog('Cancel'));
    expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="CV markdown"]')!.value).toBe('# Imported CV');
  });

  it('does not ask once the CV import was saved as cv.md', async () => {
    await open('/profile');
    await type(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="CV markdown"]')!, '# Imported CV');
    await click(button('Save as cv.md'));
    await click(inDialog('Replace cv.md'));
    expect(host.textContent).toContain('cv.md saved');
    await click(tab('Projects'));
    expect(dialog()).toBeNull();
    expect(tab('Projects').getAttribute('aria-selected')).toBe('true');
  });

  it('asks before a Profile tab drops a projects import draft', async () => {
    await open('/profile');
    await click(tab('Projects'));
    await type(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Projects to import"]')!, '[{"name": "Kite"}]');
    await click(tab('CV'));
    expect(dialog()?.textContent).toContain('the projects import');
  });

  it('asks before browser Back leaves a Settings tab with unsaved blacklist rows, and Cancel stays with them', async () => {
    await open('/settings?tab=portals', true);
    await act(async () => router.navigate({ to: '/settings', search: { tab: 'blacklist' } }));
    await settle();
    await type(document.querySelector<HTMLInputElement>('[aria-label="Blacklist company or domain"]')!, 'Spam Co');
    await click(button('Add row'));
    await act(async () => window.history.back());
    await act(async () => new Promise((r) => setTimeout(r, 150)));
    expect(dialog()?.textContent).toContain('data/blacklist.md');
    await click(inDialog('Cancel'));
    expect(router.state.location.search).toEqual({ tab: 'blacklist' });
    expect(host.textContent).toContain('Spam Co');
  });

  it('asks before a link leaves the page, and leaves when the user discards', async () => {
    await open('/settings?tab=blacklist');
    await type(document.querySelector<HTMLInputElement>('[aria-label="Blacklist company or domain"]')!, 'Spam Co');
    await click(button('Add row'));
    await act(async () => void router.navigate({ to: '/runs' }));
    await settle();
    expect(dialog()?.textContent).toContain('data/blacklist.md');
    await click(inDialog('Discard changes'));
    expect(host.textContent).toContain('Runs page');
  });

  it('switches a guarded tab once, without asking twice', async () => {
    await open('/settings?tab=blacklist');
    await type(document.querySelector<HTMLInputElement>('[aria-label="Blacklist company or domain"]')!, 'Spam Co');
    await click(button('Add row'));
    await click(tab('Portals'));
    await click(inDialog('Discard changes'));
    expect(dialog()).toBeNull();
    expect(router.state.location.search).toEqual({ tab: 'portals' });
  });
});

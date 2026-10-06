// The unsaved-changes guard covers every editor that holds a draft (SW4-tests-06), and every way of leaving: a tab, browser Back
// (a Settings tab is a search param, so history moves it) and a sidebar link (SW4-web-b-01).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserHistory, createMemoryHistory, createRootRoute, createRoute, createRouter, type AnyRouter } from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '@web/components/ConfirmDialog';
import { SETTINGS_TABS, SettingsPage } from '@web/features/settings/SettingsPage';
import { ProfilePage } from '@web/features/profile/ProfilePage';
import type { UserFile } from '@web/lib/queries';
import type { AppSettingsRead, CadenceRead, ConfigRead, SystemStatus, UsageResponse } from '@shared/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let router: AnyRouter;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const userFile = (key: string, path: string): UserFile => ({ key, path, kind: 'ok', text: `# ${path}\n`, etag: `${key}-1` });
const window0 = { tokens: 0, input: 0, output: 0, cacheCreation: 0, messages: 0 };
const READS: Record<string, unknown> = {
  '/api/blacklist': { kind: 'ok', path: 'data/blacklist.md', raw: '', etag: 'b1', rows: [], preamble: null, postamble: '', extraColumns: [] },
  '/api/config/portals': { key: 'portals', path: 'portals.yml', kind: 'ok', raw: 'a: 1\n', etag: 'p1', doc: { a: 1 }, parseError: null },
  '/api/files/user/cv': { key: 'cv', path: 'cv.md', kind: 'ok', text: '# CV\n', etag: 'c1' },
  '/api/projects': { path: 'article-digest.md', kind: 'ok', etag: 'e1', entries: [], validation: { ok: true, errors: [], warnings: [] } },
  '/api/files/user/customMd': userFile('customMd', 'modes/_custom.md'),
  '/api/files/user/articleDigest': userFile('articleDigest', 'article-digest.md'),
  '/api/files/user/profileMd': userFile('profileMd', 'modes/_profile.md'),
  '/api/config/profile': { key: 'profile', path: 'config/profile.yml', kind: 'ok', raw: 'language:\n  output: en\n', etag: 'pr1', doc: { language: { output: 'en' } }, parseError: null } satisfies ConfigRead,
  '/api/followups/cadence': { kind: 'ok', etag: 'pr1', cadence: { applied_first_days: 7 }, keys: ['applied_first_days', 'applied_subsequent_days', 'applied_max_followups', 'responded_initial_days', 'responded_subsequent_days', 'interview_thankyou_days'], parseError: null } satisfies CadenceRead,
  '/api/settings/app': { logos: false, retention: 500, claudeConcurrency: 2, modelDefault: '', usageBudgets: { fiveHourTokens: null, sevenDayTokens: 2000000 }, problem: null } satisfies AppSettingsRead,
  '/api/system/status': { node: 'v24.0.0', claude: { bin: '/usr/local/bin/claude', version: '2.1.0', error: null, approved: true, problem: null }, roots: { code: '/code', data: '/data' }, keychainTokenPresent: true, anthropicApiKeySet: false, careerOps: { version: '1.0.0' } } satisfies SystemStatus,
  '/api/sessions/engine': { playwrightAvailable: false, modes: [] },
  '/api/usage': { kind: 'ok', dir: '/home/.claude/projects', fiveHour: window0, sevenDay: window0, files: 0, computedAt: '2026-10-06T12:00:00.000Z', budgets: { fiveHourTokens: null, sevenDayTokens: 2000000 } } satisfies UsageResponse,
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

  const field = (selector: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  // Every editor that registers unsaved edits: open it, type, switch away by a tab, and the discard question names it.
  it.each([
    { editor: 'the house rules file', entry: '/settings?tab=rules', before: [], input: 'textarea[aria-label="modes/_custom.md (house rules) contents"]', value: 'Never apply on Fridays.', away: 'Portals', named: 'modes/_custom.md (house rules)' },
    { editor: 'a More files file', entry: '/profile', before: ['More files'], input: 'textarea[aria-label="article-digest.md contents"]', value: '## Kite', away: 'CV', named: 'article-digest.md' },
    { editor: 'the cv.md editor', entry: '/profile', before: [], input: 'textarea[aria-label="cv.md contents"]', value: '# Jane Doe', away: 'Projects', named: 'cv.md' },
    { editor: 'the raw portals.yml editor', entry: '/settings?tab=portals', before: ['Raw YAML'], input: 'textarea[aria-label="portals.yml YAML"]', value: 'a: 2\n', away: 'Structured', named: 'portals.yml' },
    { editor: 'the raw config/profile.yml editor', entry: '/settings?tab=profile', before: ['Raw YAML'], input: 'textarea[aria-label="config/profile.yml YAML"]', value: 'language:\n  output: de\n', away: 'Form', named: 'config/profile.yml' },
    { editor: 'the open project form', entry: '/profile', before: ['Projects', 'Add project'], input: 'input[aria-label="Title"]', value: 'Kite', away: 'CV', named: 'the open project form' },
    { editor: 'the follow-up cadence form', entry: '/settings?tab=profile', before: ['Follow-up cadence'], input: '#cadence-applied_first_days', value: '10', away: 'Form', named: 'the follow-up cadence' },
    { editor: 'the run retention', entry: '/settings?tab=app', before: [], input: '#setting-retention', value: '900', away: 'Portals', named: 'the run retention' },
    { editor: 'the model default', entry: '/settings?tab=engine', before: [], input: '#setting-model', value: 'claude-opus-4-1', away: 'App', named: 'the model default' },
    { editor: 'the 5 hour token budget', entry: '/settings?tab=engine', before: [], input: 'input[aria-label="5 hour token budget"]', value: '500000', away: 'App', named: 'the token budgets' },
    { editor: 'the 7 day token budget', entry: '/settings?tab=engine', before: [], input: 'input[aria-label="7 day token budget"]', value: '', away: 'App', named: 'the token budgets' },
  ])('asks before a tab drops an edit in $editor, and Cancel keeps it', async ({ entry, before, input, value, away, named }) => {
    await open(entry);
    for (const name of before) await click(button(name));
    await type(field(input), value);
    await click(tab(away));
    expect(dialog()?.textContent).toContain(`${named} has unsaved changes`);
    await click(inDialog('Cancel'));
    expect(field(input).value).toBe(value);
  });

  it('asks before a structured config/profile.yml change is dropped', async () => {
    await open('/settings?tab=profile');
    await click(button('Add candidate'));
    await click(tab('Raw YAML'));
    expect(dialog()?.textContent).toContain('config/profile.yml has unsaved changes');
    await click(inDialog('Cancel'));
    expect(host.textContent).toContain('1 pending change');
  });

  it('asks before the More files picker drops an edit, and Cancel keeps the file open', async () => {
    await open('/profile');
    await click(tab('More files'));
    await type(field('textarea[aria-label="article-digest.md contents"]'), '## Kite');
    const picker = document.querySelector<HTMLSelectElement>('select[aria-label="User file"]')!;
    await act(async () => {
      picker.value = 'profileMd';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(dialog()?.textContent).toContain('article-digest.md has unsaved changes');
    await click(inDialog('Cancel'));
    expect(field('textarea[aria-label="article-digest.md contents"]').value).toBe('## Kite');
  });

  it.each([
    { setting: 'run retention', entry: '/settings?tab=app', input: '#setting-retention', saved: '500', away: 'Portals' },
    { setting: 'model default', entry: '/settings?tab=engine', input: '#setting-model', saved: '', away: 'App' },
    { setting: '7 day token budget', entry: '/settings?tab=engine', input: 'input[aria-label="7 day token budget"]', saved: '2000000', away: 'App' },
  ])('does not ask when the $setting is typed back to its saved value', async ({ entry, input, saved, away }) => {
    await open(entry);
    await type(field(input), '42');
    await type(field(input), saved);
    await click(tab(away));
    expect(dialog()).toBeNull();
    expect(tab(away).getAttribute('aria-selected')).toBe('true');
  });
});

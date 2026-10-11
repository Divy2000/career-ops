// Settings > AI engine renders the three Keychain token states from /api/system/status: a token that could not be read
// (a locked keychain, a timeout) shows the reader's reason, not the "missing" advice that would replace a fine token.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '@web/components/ConfirmDialog';
import { SETTINGS_TABS, SettingsPage } from '@web/features/settings/SettingsPage';
import { until } from '../helpers/until';
import type { AppSettingsRead, SystemStatus, UsageResponse } from '@shared/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const window0 = { tokens: 0, input: 0, output: 0, cacheCreation: 0, messages: 0 };
const READS: Record<string, unknown> = {
  '/api/settings/app': { logos: false, retention: 500, claudeConcurrency: 2, modelDefault: '', usageBudgets: { fiveHourTokens: null, sevenDayTokens: 2000000 }, problem: null } satisfies AppSettingsRead,
  '/api/sessions/engine': { playwrightAvailable: false, modes: [] },
  '/api/usage': { kind: 'ok', dir: '/home/.claude/projects', fiveHour: window0, sevenDay: window0, files: 0, computedAt: '2026-10-06T12:00:00.000Z', budgets: { fiveHourTokens: null, sevenDayTokens: 2000000 } } satisfies UsageResponse,
};
const MISSING = { node: 'v24.0.0', claude: { bin: '/usr/local/bin/claude', version: '2.1.0', error: null, approved: true, problem: null }, roots: { code: '/code', data: '/data' }, keychainTokenPresent: false, keychainToken: { state: 'missing', reason: null }, anthropicApiKeySet: false, careerOps: { version: '1.0.0' } } satisfies SystemStatus;

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});


async function renderEngine(status: SystemStatus): Promise<void> {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url === '/api/system/status' ? status : (READS[url.split('?')[0]!] ?? []))));
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const rootRoute = createRootRoute();
  const settings = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage, validateSearch: (s: Record<string, unknown>) => ({ tab: (SETTINGS_TABS as readonly string[]).includes(String(s.tab)) ? s.tab : 'portals' }) });
  const router = createRouter({ routeTree: rootRoute.addChildren([settings]), history: createMemoryHistory({ initialEntries: ['/settings?tab=engine'] }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(RouterProvider, { router })))));
}

/** The <dd> after the "Keychain token" <dt>. */
async function tokenRow(): Promise<HTMLElement> {
  const dt = await until(() => [...host.querySelectorAll('dt')].find((d) => d.textContent === 'Keychain token'), 'the Keychain token row');
  return dt.nextElementSibling as HTMLElement;
}

const LOCKED = 'Could not read Keychain item career-ops-claude-token: security failed (exit 36: security: SecKeychainSearchCopyNext: User interaction is not allowed.). The login keychain is probably locked or cannot prompt (for example over SSH or before login). Unlock it with: security unlock-keychain, then retry.';

describe('Settings > AI engine: the Keychain token row (R22-fu-5)', () => {
  it('given a token that could not be read, then it says so with the reason and never advises replacing the token', async () => {
    await renderEngine({ ...MISSING, keychainToken: { state: 'unreadable', reason: LOCKED } });
    const row = await tokenRow();
    expect(row.querySelector('.chip')?.textContent).toBe('could not read');
    expect(row.querySelector('.chip')?.className).toContain('chip--warn');
    expect(row.textContent).toContain(LOCKED);
    expect(row.textContent).not.toContain('missing');
    expect(row.textContent).not.toContain('claude setup-token');
  });

  it('given an absent token, then it says missing with the command that stores one', async () => {
    await renderEngine(MISSING);
    const row = await tokenRow();
    expect(row.querySelector('.chip')?.className).toContain('chip--danger');
    expect(row.textContent).toContain('missing (claude setup-token, then security add-generic-password -U -a "$USER" -s career-ops-claude-token -w)');
    expect(row.textContent).not.toContain('unlock-keychain');
  });

  it('given a stored token, then it says present', async () => {
    await renderEngine({ ...MISSING, keychainTokenPresent: true, keychainToken: { state: 'present', reason: null } });
    const row = await tokenRow();
    expect(row.textContent).toBe('present');
    expect(row.querySelector('.chip')?.className).toContain('chip--ok');
  });
});

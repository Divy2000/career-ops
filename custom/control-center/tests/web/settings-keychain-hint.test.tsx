// Settings > AI engine with no Keychain token: the hint is the command that stores one, the same as the server's own
// error and install.sh. Without -w `security` stores an empty password (still "missing"), and without -U a rerun fails
// with "item already exists" (R13-feat-c-L2-02).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, expect, it, vi } from 'vitest';
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
const STATUS = { node: 'v24.0.0', claude: { bin: '/usr/local/bin/claude', version: '2.1.0', error: null, approved: true, problem: null }, roots: { code: '/code', data: '/data' }, keychainTokenPresent: false, anthropicApiKeySet: false, careerOps: { version: '1.0.0' } } satisfies SystemStatus;

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('the missing-token hint gives the full command that stores the token', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url === '/api/system/status' ? STATUS : (READS[url.split('?')[0]!] ?? []))));
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const rootRoute = createRootRoute();
  const settings = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage, validateSearch: (s: Record<string, unknown>) => ({ tab: (SETTINGS_TABS as readonly string[]).includes(String(s.tab)) ? s.tab : 'portals' }) });
  const router = createRouter({ routeTree: rootRoute.addChildren([settings]), history: createMemoryHistory({ initialEntries: ['/settings?tab=engine'] }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(RouterProvider, { router })))));
  const hint = await until(() => [...host.querySelectorAll('dd')].find((d) => d.textContent?.includes('missing')), 'the Keychain token row');
  expect(hint.textContent).toContain('claude setup-token, then security add-generic-password -U -a "$USER" -s career-ops-claude-token -w');
});

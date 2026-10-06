// Insights > Patterns with 1 to 4 applications sent: analyze-patterns.mjs prints its "Not enough data" object and exits 1
// (only its noData errors exit 0). That is the empty state, not a failed script; a real failure still says it failed (R7-12).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { until } from '../helpers/until';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptTab } from '@web/features/insights/ScriptTab';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CODE_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

let host: HTMLElement;
let root: Root;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

async function mount(read: { exit: number; json: unknown; text: string }) {
  const body = { script: 'analyzePatterns', label: 'Patterns', kind: read.exit === 0 ? 'ok' : 'failed', computedAt: '2026-10-05T12:00:00.000Z', inputsKey: 'k', fromCache: false, ...read };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ScriptTab, { script: 'analyzePatterns', title: 'Patterns' }))));
  // The run's timestamp shows once the read has landed.
  await until(() => host.textContent?.includes('computed'), 'the script read');
}

describe('an insights script that exits 1 with its own "not enough data" answer', () => {
  it('shows the empty state for what analyze-patterns.mjs prints on a tracker with 4 applications sent', async () => {
    const run = spawnSync(process.execPath, [path.join(CODE_ROOT, 'analyze-patterns.mjs')], { cwd: CODE_ROOT, env: { ...process.env, CAREER_OPS_ROOT: path.join(PACKAGE_ROOT, 'tests', 'fixtures', 'root'), NO_COLOR: '1' }, encoding: 'utf8' });
    expect(run.status).toBe(1);
    await mount({ exit: run.status!, json: JSON.parse(run.stdout), text: run.stdout });
    expect(host.textContent).toContain('Not enough data: 4/5 applications sent.');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toContain('The script exited');
  });

  it('still reports a real failure that prints an error object', async () => {
    await mount({ exit: 1, json: { error: 'Cannot read data/applications.md: EACCES' }, text: '{"error":"Cannot read data/applications.md: EACCES"}' });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('The script exited 1.');
  });
});

// Discover > Network scan: the default Exclude keyword is meant for internships. The scanner matches a bare keyword of 4+
// letters anywhere in a title, so a bare `intern` also vetoed "Internal Tools" and "International Payments" roles that
// match the default Roles (R25-feat-a-L2-01). The defaults run here through the scanner's own title filter.
import { createElement } from 'react';
import { act } from 'react';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

class FakeEventSource {
  constructor(public url: string) {}
  addEventListener() {}
  close() {}
}

let host: HTMLElement;
let root: Root;
let sent: Array<{ params: { roles: string[]; exclude: string[] } }>;

beforeEach(async () => {
  sessionStorage.clear();
  sent = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/actions/scan.network') sent.push(JSON.parse(String(init?.body)));
      const body = url === '/api/actions/scan.network' ? { runId: 'r1' } : url === '/api/actions' ? [] : {};
      return new Response(JSON.stringify(body), { status: url === '/api/actions/scan.network' ? 202 : 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  const { NetworkScan } = await import('@web/features/discover/DiscoverPage');
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(NetworkScan))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

/** Runs the form's default filters, as sent, through the scanner's own buildTitleFilter: which titles it keeps. */
async function keptByDefaults(titles: string[]): Promise<boolean[]> {
  await act(async () => host.querySelector<HTMLFormElement>('form[aria-label="Network scan filters"]')!.requestSubmit());
  const { params } = await until(() => sent[0], 'the scan request');
  const script = `import { buildTitleFilter } from ${JSON.stringify(path.join(CODE_ROOT, 'title-keywords.mjs'))};
const keep = buildTitleFilter(${JSON.stringify({ positive: params.roles, negative: params.exclude })});
process.stdout.write(JSON.stringify(${JSON.stringify(titles)}.map(keep)));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  expect(run.stderr).toBe('');
  return JSON.parse(run.stdout) as boolean[];
}

describe('Network scan default filters', () => {
  it('keep backend and platform roles whose titles contain "internal" or "international"', async () => {
    expect(await keptByDefaults(['Platform Engineer, Internal Developer Platform', 'Backend Engineer - International Payments', 'Internal Tools Backend Engineer'])).toEqual([true, true, true]);
  });

  it('still drop internships', async () => {
    expect(await keptByDefaults(['Backend Engineer Intern', 'Platform Engineering Internship'])).toEqual([false, false]);
  });

  it('say beside the Exclude field how a keyword matches', () => {
    expect(host.textContent).toMatch(/word:/);
  });
});

// Runs & Schedule job cards: one launchd update at a time (two concurrent writes share the server's temp plist), and
// the time fields follow the plist on disk, so Disable never writes a stale time back (R13-feat-b-L1-06, -L2-02).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let qc: QueryClient;
let puts: Array<Record<string, unknown>>;
let hold: boolean;
let release: Array<() => void>;
let job: Record<string, unknown>;

beforeEach(async () => {
  puts = [];
  hold = false;
  release = [];
  job = {
    label: 'com.career-ops.immigration-watch', kind: 'daily', title: 'Daily job', script: 'custom/immigration/run-daily.sh', logDir: 'data/immigration/logs', plistPath: '/x.plist',
    plist: 'ok', hour: 8, minute: 0, weekday: null, programArgumentsOk: true, loaded: true, disabled: false, state: 'not running', lastExit: 0, lastSignal: null, runs: 1, nextFire: null, error: null,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (hold) await new Promise<void>((r) => release.push(r));
      }
      const body = url === '/api/schedule' ? { jobs: [job], agentsDir: '/agents' } : url === '/api/actions' ? [] : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  const { ScheduleCards } = await import('@web/features/runs/ScheduleCards');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(ScheduleCards)))));
  await until(() => host.querySelector('input[aria-label="Daily job hour"]'), 'the daily job card');
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === name)!;
const field = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

describe('schedule job card', () => {
  it('Save time then Disable while the first update is in flight sends one update (R13-feat-b-L1-06)', async () => {
    hold = true;
    await act(async () => button('Save time').click());
    await until(() => release.length === 1 || undefined, 'the held update');
    expect(button('Save time').disabled).toBe(true);
    expect(button('Disable').disabled).toBe(true);
    await act(async () => button('Disable').click());
    expect(puts).toHaveLength(1);
    await act(async () => release.forEach((r) => r()));
    await until(() => !button('Save time').disabled, 'the buttons back');
  });

  it('a time changed elsewhere shows in the fields, and Disable keeps it (R13-feat-b-L2-02)', async () => {
    job = { ...job, hour: 9, minute: 30 };
    await act(async () => qc.invalidateQueries({ queryKey: ['system', 'schedule'] }));
    await until(() => field('Daily job hour').value === '9', 'the new hour');
    expect(field('Daily job minute').value).toBe('30');
    await act(async () => button('Disable').click());
    await until(() => puts.length === 1 || undefined, 'the update');
    expect(puts[0]).toEqual({ hour: 9, minute: 30, enabled: false });
  });
});

// Runs & Schedule (R8-15): Number('') is 0 and the schedule route accepts hour 0, so a cleared Hour or Minute must be
// refused on the page instead of scheduling the job at 00.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { until } from '../helpers/until';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduleCards } from '@web/features/runs/ScheduleCards';
import { ConfirmProvider } from '@web/components/ConfirmDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let puts: Array<{ url: string; body: Record<string, unknown> }>;

const JOB = {
  label: 'com.career-ops.immigration-watch', kind: 'daily', title: 'Daily job', script: 'custom/immigration/run-daily.sh', logDir: 'data/immigration/logs', plistPath: '/x.plist',
  plist: 'ok', hour: 8, minute: 30, weekday: null, programArgumentsOk: true, loaded: true, disabled: false, state: 'not running', lastExit: 0, lastSignal: null, runs: 1, nextFire: null, error: null,
};

beforeEach(async () => {
  puts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') puts.push({ url, body: JSON.parse(String(init.body)) });
      const body = url === '/api/schedule' ? { jobs: [JOB], agentsDir: '/agents' } : url === '/api/actions' ? [] : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(ScheduleCards)))));
  await until(() => host.querySelector('input[aria-label="Daily job hour"]'), 'the daily job card');
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

async function type(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const click = (name: string) => act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!.click());

describe('the schedule time fields', () => {
  for (const [field, value] of [['hour', ''], ['minute', ''], ['hour', '24'], ['minute', '7.5']] as const) {
    it(`refuses ${field} ${JSON.stringify(value)} instead of saving it`, async () => {
      await type(`Daily job ${field}`, value);
      await click('Save time');
      expect(puts).toEqual([]);
      expect(host.querySelector('[role="alert"]')?.textContent).toMatch(new RegExp(field, 'i'));
    });
  }

  it('still saves midnight typed as 0', async () => {
    await type('Daily job hour', '0');
    await type('Daily job minute', '0');
    await click('Save time');
    expect(puts).toEqual([{ url: '/api/schedule/com.career-ops.immigration-watch', body: { hour: 0, minute: 0, enabled: true } }]);
  });
});

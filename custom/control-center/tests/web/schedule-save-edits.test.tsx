// Runs & Schedule (R35-feat-b-L1-01): Save time waits on launchd and the schedule refetch, and the fields stay editable
// meanwhile. A time typed during that wait is not what was saved, so the save must keep it as an unsaved edit.
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
let job: Record<string, unknown>;
let puts: Array<Record<string, unknown>>;
// Each PUT waits here until the test answers it, as launchd's bootout and bootstrap take seconds.
let answerPut: (() => void) | null;
let qc: QueryClient;

const JOB = {
  label: 'com.career-ops.immigration-watch', kind: 'daily', title: 'Daily job', script: 'custom/immigration/run-daily.sh', logDir: 'data/immigration/logs', plistPath: '/x.plist',
  plist: 'ok', hour: 8, minute: 30, weekday: null, programArgumentsOk: true, loaded: true, disabled: false, state: 'not running', lastExit: 0, lastSignal: null, runs: 1, nextFire: null, error: null,
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  job = { ...JOB };
  puts = [];
  answerPut = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        puts.push(body);
        await new Promise<void>((resolve) => (answerPut = resolve));
        // As the route: the plist on disk now holds the saved time.
        job = { ...job, hour: body.hour, minute: body.minute };
        return json({ ok: true });
      }
      return json(url === '/api/schedule' ? { jobs: [job], agentsDir: '/agents' } : url === '/api/actions' ? [] : { ok: true });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(ScheduleCards)))));
  await until(() => host.querySelector('input[aria-label="Daily job hour"]'), 'the daily job card');
});

afterEach(async () => {
  answerPut?.();
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

const field = (name: string) => host.querySelector<HTMLInputElement>(`input[aria-label="Daily job ${name}"]`)!;
async function type(name: string, value: string) {
  const input = field(name);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const click = (name: string) => act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!.click());

describe('Save time with a time typed while it runs', () => {
  it('given a minute typed while the save of the hour is in flight, when the save finishes, then the hour shows the saved value and the typed minute stays', async () => {
    await type('hour', '9');
    await click('Save time');
    await until(() => answerPut ?? undefined, 'the PUT in flight');
    expect(puts).toEqual([{ hour: 9, minute: 30, enabled: true }]);
    await type('minute', '45');
    await act(async () => answerPut!());
    await until(() => (field('hour').value === '9' && !host.querySelector('button.button--primary:disabled')) || undefined, 'the save settled');
    expect(field('hour').value).toBe('9');
    expect(field('minute').value).toBe('45');
  });

  it('given nothing typed during the save, when it finishes, then no edit is left and the fields follow the plist from then on', async () => {
    await type('hour', '9');
    await type('minute', '15');
    await click('Save time');
    await until(() => answerPut ?? undefined, 'the PUT in flight');
    await act(async () => answerPut!());
    await until(() => (job.minute === 15 && !host.querySelector('button.button--primary:disabled')) || undefined, 'the save settled');
    // The plist moves on elsewhere (another tab, install.sh): with no edit left, the fields follow it.
    job = { ...job, hour: 6, minute: 5 };
    await act(async () => qc.invalidateQueries({ queryKey: ['system', 'schedule'] }));
    await until(() => field('hour').value === '6' || undefined, 'the hour from the plist');
    expect(field('minute').value).toBe('5');
  });
});

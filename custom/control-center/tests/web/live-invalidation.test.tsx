import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveInvalidation } from '@web/lib/sse';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The app's /api/events stream, driven by the test. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  private listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  constructor(public url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  close() {}
}

let host: HTMLElement;
let root: Root;
const fetches: Record<string, number> = {};

function Probe() {
  useLiveInvalidation();
  // The job-log readers: the top-bar chip, the Job logs card, and the Today page chip (the immigration overview).
  useQuery({ queryKey: ['immigration', 'logs', 'immigration-watch'], queryFn: () => ((fetches.chip = (fetches.chip ?? 0) + 1), { ok: true }) });
  useQuery({ queryKey: ['immigration', 'logs', 'immigration-watch', '2026-10-05'], queryFn: () => ((fetches.log = (fetches.log ?? 0) + 1), { ok: true }) });
  useQuery({ queryKey: ['immigration'], queryFn: () => ((fetches.today = (fetches.today ?? 0) + 1), { ok: true }) });
  return null;
}

beforeEach(async () => {
  for (const k of Object.keys(fetches)) delete fetches[k];
  vi.stubGlobal('EventSource', FakeEventSource);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Probe))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('live invalidation', () => {
  it('a daily.status event refetches the job-log status, so a run that died without its done line stops reading running, on Today too', async () => {
    expect(fetches).toEqual({ chip: 1, log: 1, today: 1 });
    await act(async () => FakeEventSource.last!.emit('daily.status', { running: false }));
    await until(() => fetches.chip === 2 && fetches.log === 2 && fetches.today === 2, 'all three refetches');
    expect(fetches).toEqual({ chip: 2, log: 2, today: 2 });
  });
});

describe('live invalidation of the Sponsorship lookup', () => {
  function LookupProbe() {
    useLiveInvalidation();
    // Sponsorship > Lookup (LookupTab.tsx): the saved check for one company.
    useQuery({ queryKey: ['sponsorship', 'lookup', 'Acme'], queryFn: () => ((fetches.lookup = (fetches.lookup ?? 0) + 1), { ok: true }) });
    return null;
  }

  it('a change under data/immigration/ (a sponsorship check saving its result) refetches the lookup', async () => {
    await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }) }, createElement(LookupProbe))));
    await until(() => fetches.lookup === 1, 'the first lookup fetch');
    await act(async () => FakeEventSource.last!.emit('data.changed', { domain: 'immigration', paths: ['data/immigration/company-checks/acme.md'] }));
    await until(() => fetches.lookup === 2, 'the lookup refetch');
    expect(fetches.lookup).toBe(2);
  });
});

describe('live invalidation of what a page session writes (SW-web-a-11)', () => {
  function PageProbe() {
    useLiveInvalidation();
    // Application > Sponsorship reads the company file through the row's detail; the Interviews page reads interview-prep/.
    useQuery({ queryKey: ['tracker', 'row', '1'], queryFn: () => ((fetches.row = (fetches.row ?? 0) + 1), { ok: true }) });
    useQuery({ queryKey: ['tracker', 'interviews'], queryFn: () => ((fetches.interviews = (fetches.interviews ?? 0) + 1), { ok: true }) });
    return null;
  }

  beforeEach(async () => {
    await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }) }, createElement(PageProbe))));
    await until(() => fetches.row === 1 && fetches.interviews === 1, 'the first fetches');
  });

  it('a sponsorship check saving its company file refetches the application it was run from', async () => {
    await act(async () => FakeEventSource.last!.emit('data.changed', { domain: 'immigration', paths: ['data/immigration/companies/acme-robotics.md'] }));
    await until(() => fetches.row === 2, 'the application refetch');
  });

  it('a debrief or prep session writing under interview-prep/ refetches the Interviews page', async () => {
    await act(async () => FakeEventSource.last!.emit('data.changed', { domain: 'interviews', paths: ['interview-prep/sessions/debrief.md'] }));
    await until(() => fetches.interviews === 2, 'the interviews refetch');
  });
});

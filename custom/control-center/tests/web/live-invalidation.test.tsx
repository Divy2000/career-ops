import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveInvalidation } from '@web/lib/sse';

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
  // The two job-log readers: the top-bar chip and the Job logs card.
  useQuery({ queryKey: ['immigration', 'logs', 'immigration-watch'], queryFn: () => ((fetches.chip = (fetches.chip ?? 0) + 1), { ok: true }) });
  useQuery({ queryKey: ['immigration', 'logs', 'immigration-watch', '2026-10-05'], queryFn: () => ((fetches.log = (fetches.log ?? 0) + 1), { ok: true }) });
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
  it('a daily.status event refetches the job-log status, so a run that died without its done line stops reading running', async () => {
    expect(fetches).toEqual({ chip: 1, log: 1 });
    await act(async () => FakeEventSource.last!.emit('daily.status', { running: false }));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(fetches).toEqual({ chip: 2, log: 2 });
  });
});

// The shared /api/events stream: what each server domain refetches, and recovering a stream the browser closed for
// good (the supervisor's 503 down page or 502 while the server child is down after a crash).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_STREAM_RETRY, subscribeAppEvents, useLiveInvalidation } from '@web/lib/sse';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The app's /api/events stream, driven by the test. readyState follows the EventSource constants. */
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static all: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  private listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  constructor(public url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown) {
    if (type === 'open') this.readyState = 1;
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  /** The browser gave up: a non-200 or non-event-stream answer fails the connection with no further retry. */
  fail() {
    this.readyState = 2;
    for (const fn of this.listeners.get('error') ?? []) fn(new MessageEvent('error'));
  }
  /** A dropped connection the browser retries by itself. */
  drop() {
    this.readyState = 0;
    for (const fn of this.listeners.get('error') ?? []) fn(new MessageEvent('error'));
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}
const latest = () => FakeEventSource.all.at(-1)!;

let host: HTMLElement;
let root: Root;
const fetches: Record<string, number> = {};
const retry = { ...APP_STREAM_RETRY };

function Probe() {
  useLiveInvalidation();
  // Profile > More files > interview-prep/story-bank.md, and an Insights script tab.
  useQuery({ queryKey: ['config', 'user-file', 'storyBank'], queryFn: () => ((fetches.storyBank = (fetches.storyBank ?? 0) + 1), { ok: true }) });
  useQuery({ queryKey: ['insights', 'upskill'], queryFn: () => ((fetches.insights = (fetches.insights ?? 0) + 1), { ok: true }) });
  return null;
}

beforeEach(async () => {
  for (const k of Object.keys(fetches)) delete fetches[k];
  FakeEventSource.all = [];
  Object.assign(APP_STREAM_RETRY, { baseMs: 5, maxMs: 20 });
  vi.stubGlobal('EventSource', FakeEventSource);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }) }, createElement(Probe))));
  await until(() => fetches.storyBank === 1 && fetches.insights === 1, 'the first fetches');
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Object.assign(APP_STREAM_RETRY, retry);
  vi.unstubAllGlobals();
});

describe('what each domain refetches', () => {
  it('a story-bank change under interview-prep/ refetches its Profile editor (R13-weblib-L2-01)', async () => {
    await act(async () => latest().emit('data.changed', { domain: 'interviews', paths: ['interview-prep/story-bank.md'] }));
    await until(() => fetches.storyBank === 2, 'the story-bank refetch');
  });

});

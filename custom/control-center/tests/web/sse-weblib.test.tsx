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
  // The Follow-ups page and the What's New feed.
  useQuery({ queryKey: ['followups'], queryFn: () => ((fetches.followups = (fetches.followups ?? 0) + 1), { ok: true }) });
  useQuery({ queryKey: ['pipeline', 'whats-new', 7, 12], queryFn: () => ((fetches.whatsNew = (fetches.whatsNew ?? 0) + 1), { ok: true }) });
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
  await until(() => fetches.storyBank === 1 && fetches.insights === 1 && fetches.followups === 1 && fetches.whatsNew === 1, 'the first fetches');
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

  it.each(['config', 'pipeline', 'followups'])('a %s change refetches the Insights scripts that read its files (R13-weblib-L2-02)', async (domain) => {
    await act(async () => latest().emit('data.changed', { domain, paths: [] }));
    await until(() => fetches.insights === 2, `the insights refetch after ${domain}`);
  });

  it('a tracker change refetches What\'s New, which reads applications.md (R17-weblib-L2-01)', async () => {
    await act(async () => latest().emit('data.changed', { domain: 'tracker', paths: [] }));
    await until(() => fetches.whatsNew === 2, 'the whats-new refetch after a tracker change');
  });

  it('a config change refetches Follow-ups, whose cadence lives in profile.yml (R17-weblib-L2-01)', async () => {
    await act(async () => latest().emit('data.changed', { domain: 'config', paths: [] }));
    await until(() => fetches.followups === 2, 'the followups refetch after a config change');
  });
});

describe('a stream the browser closed for good (R13-weblib-L1-01, R13-weblib-L3-01)', () => {
  it('is opened again, its subscribers keep hearing frames, and the reopen refetches everything', async () => {
    const first = latest();
    await act(async () => first.emit('open', null));
    await act(async () => first.fail());
    await until(() => FakeEventSource.all.length === 2, 'a new EventSource');
    expect(first.closed).toBe(true);
    const second = latest();
    await act(async () => second.emit('open', null));
    await until(() => fetches.storyBank === 2 && fetches.insights === 2, 'the refetch on reopen');
    await act(async () => second.emit('data.changed', { domain: 'interviews', paths: [] }));
    await until(() => fetches.storyBank === 3, 'a frame on the new stream');
  });

  it('counts the first open after a refused first connection as a reconnect, since changes it missed sent no event', async () => {
    await act(async () => latest().fail());
    await until(() => FakeEventSource.all.length === 2, 'a new EventSource');
    await act(async () => latest().emit('open', null));
    await until(() => fetches.storyBank === 2 && fetches.insights === 2, 'the refetch on the first open');
  });

  it('a later subscriber attaches to the new stream, not the dead one', async () => {
    await act(async () => latest().fail());
    await until(() => FakeEventSource.all.length === 2, 'a new EventSource');
    const heard: string[] = [];
    const off = subscribeAppEvents('session.event', (ev) => heard.push(String(ev.data)));
    await act(async () => latest().emit('session.event', { sessionId: 's1' }));
    off();
    expect(heard).toHaveLength(1);
  });

  it('keeps trying while each new stream is refused too', async () => {
    await act(async () => latest().fail());
    await until(() => FakeEventSource.all.length === 2, 'a second EventSource');
    await act(async () => latest().fail());
    await until(() => FakeEventSource.all.length === 3, 'a third EventSource');
  });

  it('leaves a dropped connection to the browser, which retries it itself', async () => {
    await act(async () => latest().emit('open', null));
    await act(async () => latest().drop());
    await act(async () => new Promise((r) => setTimeout(r, 40)));
    expect(FakeEventSource.all).toHaveLength(1);
  });

  it('stops trying once its last subscriber leaves', async () => {
    await act(async () => latest().fail());
    await act(async () => root.unmount());
    await act(async () => new Promise((r) => setTimeout(r, 40)));
    expect(FakeEventSource.all).toHaveLength(1);
    root = createRoot(host);
  });
});

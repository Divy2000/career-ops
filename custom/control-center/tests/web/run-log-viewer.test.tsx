// Runs > a run's log. The server sends `retry:` and an `id:` per line and replays after Last-Event-ID, so a dropped
// connection (a blue/green reload, a sleep) must resume the log, not freeze it until another run is picked (SW-web-b-04).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogViewer } from '@web/features/runs/RunsPage';
import type { RunMeta } from '@shared/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Models the browser: an error on a live stream reconnects by itself unless the page closed it. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  constructor(public url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown) {
    if (this.closed) return;
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  // A browser fires both the onerror handler and every 'error' listener.
  drop() {
    const ev = new Event('error');
    this.onerror?.(ev);
    for (const fn of this.listeners.get('error') ?? []) fn(ev as MessageEvent);
  }
  close() {
    this.closed = true;
  }
}

let host: HTMLElement;
let root: Root;
const run = { id: 'r-1', label: 'Full ATS scan', status: 'running' } as RunMeta;
const line = (seq: number, text: string) => ({ seq, ts: '2026-10-05T12:00:00.000Z', stream: 'stdout', line: text });
const log = () => host.querySelector('[aria-label="Run log"]')?.textContent ?? '';

beforeEach(async () => {
  vi.stubGlobal('EventSource', FakeEventSource);
  // jsdom lays nothing out, so elements have no scrollTo; the viewer scrolls the log to its end on each line.
  Element.prototype.scrollTo = () => {};
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(LogViewer, { run })));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
});

describe('a run log after a dropped connection', () => {
  it('given a live run whose stream drops once, when the stream comes back, then the log keeps the earlier lines and shows the new ones', async () => {
    await act(async () => FakeEventSource.last!.emit('line', line(1, 'scanning greenhouse')));
    await act(async () => FakeEventSource.last!.drop());
    await act(async () => FakeEventSource.last!.emit('line', line(2, 'scanning ashby')));
    expect(log()).toContain('scanning greenhouse');
    expect(log()).toContain('scanning ashby');
  });

  it('given a run that ends, when run.done arrives, then the viewer says it ended and stops listening', async () => {
    await act(async () => FakeEventSource.last!.emit('run.done', { status: 'done' }));
    expect(host.textContent).toContain('ended: done');
    expect(FakeEventSource.last!.closed).toBe(true);
  });
});

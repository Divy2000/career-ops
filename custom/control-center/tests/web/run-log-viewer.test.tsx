// Runs > a run's log. The server sends `retry:` and an `id:` per line and replays after Last-Event-ID, so a dropped
// connection (a blue/green reload, a sleep) must resume the log, not freeze it until another run is picked (SW-web-b-04).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogViewer } from '@web/features/runs/RunsPage';
import type { RunMeta } from '@shared/api';
import { HttpEventSource } from '../fakes/http-event-source';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A stream the test drives by hand; closing it stops delivery. */
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
  close() {
    this.closed = true;
  }
}

let host: HTMLElement;
let root: Root;
const log = () => host.querySelector('[aria-label="Run log"]')?.textContent ?? '';
// Each row is the local clock, then the line.
const logLines = () => [...host.querySelectorAll('[aria-label="Run log"] > div')].map((row) => row.childNodes[1]?.textContent);

/** The shape of tests/helpers/run-stream-server.ts, which is server code the web typecheck must not follow. */
interface RunStreamServer {
  origin: string;
  headers: Record<string, string>;
  run: RunMeta;
  dropConnections(): void;
  openGate(): void;
  close(): Promise<void>;
}
const RUN_STREAM_SERVER = '../helpers/run-stream-server';
const startRunStreamServer = async (): Promise<RunStreamServer> =>
  ((await import(/* @vite-ignore */ RUN_STREAM_SERVER)) as { startRunStreamServer(): Promise<RunStreamServer> }).startRunStreamServer();

const render = (run: RunMeta) => act(async () => root.render(createElement(LogViewer, { run })));

beforeEach(() => {
  // jsdom lays nothing out, so elements have no scrollTo; the viewer scrolls the log to its end on each line.
  Element.prototype.scrollTo = () => {};
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
});

describe('a run log after a dropped connection', () => {
  it('given a live run whose stream drops after line 1, when the browser reconnects to the real server, then the log resumes after line 1 without repeating it', async () => {
    const server = await startRunStreamServer();
    try {
      HttpEventSource.target = { origin: server.origin, headers: server.headers };
      HttpEventSource.all = [];
      vi.stubGlobal('EventSource', HttpEventSource);
      await render(server.run);
      await until(() => log().includes('scanning greenhouse'), 'line 1 over the first connection', 1000);

      await act(async () => server.dropConnections());
      // The run writes more while the client reconnects.
      server.openGate();
      await until(() => host.textContent?.includes('ended: done'), 'the run to end over the replacement connection', 1000);

      const es = HttpEventSource.all[0]!;
      expect(es.connections).toEqual([null, '1']);
      expect(logLines()).toEqual(['scanning greenhouse', 'scanning ashby', 'scanning lever']);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('given a run that ends, when run.done arrives, then the viewer says it ended and stops listening', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    await render({ id: 'r-1', label: 'Full ATS scan', status: 'running' } as RunMeta);
    await act(async () => FakeEventSource.last!.emit('run.done', { status: 'done' }));
    expect(host.textContent).toContain('ended: done');
    expect(FakeEventSource.last!.closed).toBe(true);
  });
});

// An EventSource for jsdom tests backed by a real HTTP server, so a page's stream is the server's real stream.
// Like a browser it remembers the last `id:` it received, and when the connection is lost (the request fails or the
// response ends) it reports the error, waits the server's `retry:` delay, and opens a new connection that sends that
// id as Last-Event-ID, unless the page closed it first.
import http from 'node:http';

export interface HttpEventSourceTarget {
  /** e.g. http://127.0.0.1:1234; relative URLs the page opens resolve against it. */
  origin: string;
  /** Sent on every connection (auth cookie, Host). */
  headers: Record<string, string>;
}

/** A browser's reconnection delay until the server sends `retry:`. */
const DEFAULT_RETRY_MS = 3000;

export class HttpEventSource {
  static target: HttpEventSourceTarget | null = null;
  static all: HttpEventSource[] = [];

  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  lastEventId = '';
  /** The Last-Event-ID each connection sent, in order (null when it sent none). */
  readonly connections: Array<string | null> = [];
  private retryMs = DEFAULT_RETRY_MS;
  private listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  private current: http.ClientRequest | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;

  constructor(public url: string) {
    HttpEventSource.all.push(this);
    this.connect();
  }

  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  close() {
    this.closed = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = null;
    const req = this.current;
    this.current = null;
    req?.destroy();
  }

  private connect() {
    const target = HttpEventSource.target;
    if (!target) throw new Error('HttpEventSource.target is not set: point it at the test server before rendering');
    this.reconnect = null;
    const sent = this.lastEventId || null;
    this.connections.push(sent);
    const headers = { ...target.headers, accept: 'text/event-stream', ...(sent ? { 'last-event-id': sent } : {}) };
    const req = http.get(new URL(this.url, target.origin), { headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let at: number;
        while (this.current === req && (at = buf.indexOf('\n\n')) >= 0) {
          this.dispatch(buf.slice(0, at));
          buf = buf.slice(at + 2);
        }
      });
      res.on('end', () => this.lost(req));
      res.on('close', () => this.lost(req));
    });
    req.on('error', () => this.lost(req));
    this.current = req;
  }

  /** The connection `req` is gone; a stale one (already replaced or closed by the page) changes nothing. */
  private lost(req: http.ClientRequest) {
    if (this.current !== req || this.closed) return;
    this.current = null;
    req.destroy();
    const ev = new Event('error');
    this.onerror?.(ev);
    for (const fn of this.listeners.get('error') ?? []) fn(ev as MessageEvent);
    if (!this.closed) this.reconnect = setTimeout(() => this.connect(), this.retryMs);
  }

  private dispatch(block: string) {
    const retry = /^retry: (\d+)$/m.exec(block)?.[1];
    if (retry !== undefined) this.retryMs = Number(retry);
    const id = /^id: (.*)$/m.exec(block)?.[1];
    if (id !== undefined) this.lastEventId = id;
    const type = /^event: (.*)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    if (!type || data === undefined || this.closed) return;
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data, lastEventId: this.lastEventId }));
  }
}

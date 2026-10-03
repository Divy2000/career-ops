import type { FastifyReply } from 'fastify';

export type Domain = 'tracker' | 'pipeline' | 'reports' | 'immigration' | 'followups' | 'config' | 'shortlist' | 'runs' | 'sessions';

export interface BusEvent {
  seq: number;
  type: string;
  payload: unknown;
  ts: string;
}

export function formatSse(ev: BusEvent): string {
  return `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify({ ...ev.payload as object, ts: ev.ts })}\n\n`;
}

export class EventBus {
  private seq = 0;
  private clients = new Set<FastifyReply>();
  private listeners = new Set<(ev: BusEvent) => void>();
  private heartbeat: NodeJS.Timeout | null = null;

  publish(type: string, payload: unknown): BusEvent {
    const ev: BusEvent = { seq: ++this.seq, type, payload, ts: new Date().toISOString() };
    const text = formatSse(ev);
    for (const reply of this.clients) reply.raw.write(text);
    for (const l of this.listeners) l(ev);
    return ev;
  }

  onEvent(listener: (ev: BusEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  attach(reply: FastifyReply): void {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write('retry: 2000\n\n');
    this.clients.add(reply);
    if (!this.heartbeat) this.heartbeat = setInterval(() => this.ping(), 10_000);
    reply.raw.on('close', () => {
      this.clients.delete(reply);
      if (this.clients.size === 0 && this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
    });
  }

  private ping(): void {
    for (const reply of this.clients) reply.raw.write(': ping\n\n');
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Tell every SSE client the server is about to go away, then end the streams. */
  drain(reason: string): void {
    this.publish('server.reloading', { reason });
    for (const reply of this.clients) reply.raw.end();
    this.clients.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}

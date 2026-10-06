import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { waitHealthy } from '../../supervisor/health.js';

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(null)));
});

/** A local server on a free port that answers every request with `handler`. */
async function serve(handler: http.RequestListener): Promise<number> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return (s.address() as AddressInfo).port;
}

describe('the supervisor\'s health check of a new server child (SW4-claude-01)', () => {
  it('a child that accepts the request and never answers fails the check once its time is up, instead of hanging', async () => {
    const port = await serve((req, res) => {
      req.on('close', () => res.destroy());
    });
    const started = Date.now();
    await expect(waitHealthy(port, 1500, 'h')).rejects.toThrow('healthz did not return 200 in time');
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(1400);
    expect(took).toBeLessThan(4000);
  }, 10_000);

  it('passes on 200, after retrying failures, and sends the public host', async () => {
    const hosts: string[] = [];
    let n = 0;
    const port = await serve((req, res) => {
      hosts.push(String(req.headers.host));
      res.statusCode = n++ < 2 ? 503 : 200;
      res.end();
    });
    await waitHealthy(port, 5000, '127.0.0.1:4317');
    expect(n).toBe(3);
    expect(hosts).toEqual(['127.0.0.1:4317', '127.0.0.1:4317', '127.0.0.1:4317']);
  });
});

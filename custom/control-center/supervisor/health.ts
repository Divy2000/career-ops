// The supervisor's health check of a new server child: GET /healthz until it answers 200 or the time is up.
import http from 'node:http';

/**
 * `host` is the Host header to send: the public address, as every request the proxy passes on carries. Each request
 * may take only the time left, so a child that accepts the connection and never answers fails the check on time
 * instead of hanging the start or the reload (and every reload queued behind it).
 */
export function waitHealthy(port: number, timeoutMs: number, host: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let settled = false;
      const next = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (ok) return resolve();
        if (Date.now() >= deadline) return reject(new Error('healthz did not return 200 in time'));
        setTimeout(tick, Math.min(250, Math.max(0, deadline - Date.now())));
      };
      const req = http.get({ host: '127.0.0.1', port, path: '/healthz', headers: { host } }, (res) => {
        res.resume();
        next(res.statusCode === 200);
      });
      req.setTimeout(Math.max(1, deadline - Date.now()), () => req.destroy(new Error('healthz did not answer in time')));
      req.on('error', () => next(false));
    };
    tick();
  });
}

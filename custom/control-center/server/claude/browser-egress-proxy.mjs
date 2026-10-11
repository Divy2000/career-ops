// The proxy every request of a session's Playwright browser goes through (playwright-mcp-launcher.mjs starts it). The
// guard checks only the URL a navigate call names; a redirect, a meta refresh, a clicked link, a frame or a script can
// send the browser anywhere else. Here each request and tunnel is checked as it is made: the host must pass the same
// rules as a WebFetch URL, it is resolved once, every address must be public, and the connection goes only to the
// addresses that were checked, so a name that resolves differently a second time (DNS rebinding) cannot reach a
// private one. Playwright sends loopback through the proxy too (it adds <-loopback> to Chromium's bypass list). This
// covers what Chromium sends through a proxy (HTTP, HTTPS and WebSockets); WebRTC's UDP is not proxied, but a page
// cannot read a private web page through it.
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import { checkUrlLiteral, DNS_BUDGET_MS, isPublicAddress } from './guard-policy.mjs';

const LABEL = 'browser';
const CONNECT_TIMEOUT_MS = 10_000;
const defaultLookup = (host) => dns.promises.lookup(host, { all: true, verbatim: true });
const HOP_BY_HOP = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

/** { addresses } to connect to, in order, or { status, reason } when the destination is refused. */
async function destination(raw, opts) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { status: 400, reason: `${LABEL}: ${raw} is not a valid URL` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { status: 400, reason: `${LABEL}: only http and https may be requested (${u.protocol})` };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return { status: 400, reason: `${LABEL}: ${raw} has no host` };
  if (net.isIP(host)) return opts.allow(host) ? { addresses: [host] } : { status: 403, reason: `${LABEL}: ${host} is a private, loopback or link-local address` };
  const local = checkUrlLiteral(raw, LABEL);
  if (local) return { status: 403, reason: local };
  let addrs;
  let timer;
  try {
    addrs = await Promise.race([
      Promise.resolve().then(() => opts.lookup(host)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${opts.timeoutMs} ms`)), opts.timeoutMs);
      }),
    ]);
  } catch (err) {
    return { status: 403, reason: `${LABEL}: could not resolve ${host} (${err && err.message}); refused` };
  } finally {
    clearTimeout(timer);
  }
  if (!Array.isArray(addrs) || addrs.length === 0) return { status: 403, reason: `${LABEL}: could not resolve ${host} (no addresses); refused` };
  const bad = addrs.map((a) => a && a.address).find((a) => typeof a !== 'string' || !opts.allow(a));
  if (bad !== undefined) return { status: 403, reason: `${LABEL}: ${host} resolves to ${bad}, a private, loopback or link-local address` };
  return { addresses: addrs.map((a) => a.address) };
}

/** A socket connected to the first of `addresses` (all checked) that answers; each gets CONNECT_TIMEOUT_MS. */
function connectFirst(addresses, port) {
  return new Promise((resolve, reject) => {
    let last;
    const attempt = (i) => {
      if (i >= addresses.length) return reject(last ?? new Error('no address'));
      const socket = net.connect({ host: addresses[i], port });
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy(new Error(`no answer from ${addresses[i]} within ${CONNECT_TIMEOUT_MS} ms`)));
      socket.once('error', (err) => {
        last = err;
        attempt(i + 1);
      });
      socket.once('connect', () => {
        socket.removeAllListeners('error');
        socket.removeAllListeners('timeout');
        socket.setTimeout(0);
        resolve(socket);
      });
    };
    attempt(0);
  });
}

function refuse(res, status, reason) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
  res.end(`Blocked by the career-ops guard: ${reason}\n`);
}

function refuseTunnel(socket, status, reason) {
  const body = `Blocked by the career-ops guard: ${reason}\n`;
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
}

async function forward(req, res, opts) {
  const dest = await destination(req.url ?? '', opts);
  if (!dest.addresses) return refuse(res, dest.status, dest.reason);
  const u = new URL(req.url);
  // A browser asks for https through a CONNECT tunnel; forwarding this one would send it in the clear.
  if (u.protocol !== 'http:') return refuse(res, 400, `${LABEL}: ${u.protocol} is requested through a CONNECT tunnel, not forwarded`);
  let socket;
  try {
    socket = await connectFirst(dest.addresses, Number(u.port || 80));
  } catch (err) {
    return refuse(res, 502, `${LABEL}: ${u.host} could not be reached (${err.message})`);
  }
  if (res.destroyed) return socket.destroy();
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
  headers.host = u.host;
  const upstream = http.request({ createConnection: () => socket, method: req.method, path: `${u.pathname}${u.search}`, headers, setHost: false }, (up) => {
    const out = {};
    for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k)) out[k] = v;
    res.writeHead(up.statusCode ?? 502, up.statusMessage, out);
    up.pipe(res);
  });
  upstream.on('error', (err) => refuse(res, 502, `${LABEL}: ${u.host} could not be reached (${err.message})`));
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

async function tunnel(req, client, head, opts) {
  client.on('error', () => undefined);
  const target = req.url ?? '';
  if (!/^[^/?#@\s]+:\d+$/.test(target)) return refuseTunnel(client, 400, `${LABEL}: ${target} is not a host and port`);
  const dest = await destination(`https://${target}/`, opts);
  if (!dest.addresses) return refuseTunnel(client, dest.status, dest.reason);
  const port = Number(new URL(`https://${target}/`).port || 443);
  let upstream;
  try {
    upstream = await connectFirst(dest.addresses, port);
  } catch (err) {
    return refuseTunnel(client, 502, `${LABEL}: ${target} could not be reached (${err.message})`);
  }
  if (client.destroyed) return upstream.destroy();
  upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy());
  client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  if (head && head.length) upstream.write(head);
  upstream.pipe(client);
  client.pipe(upstream);
}

/**
 * Starts the proxy on a free loopback port. `lookup` and `allow` (which addresses may be reached; public ones by
 * default) are there for tests. Resolves to { port, close() }.
 */
export async function startEgressProxy(options = {}) {
  const opts = { lookup: options.lookup ?? defaultLookup, allow: options.allow ?? isPublicAddress, timeoutMs: options.timeoutMs ?? DNS_BUDGET_MS };
  const server = http.createServer((req, res) => {
    forward(req, res, opts).catch((err) => refuse(res, 502, `${LABEL}: ${err && err.message}`));
  });
  const tunnels = new Set();
  server.on('connect', (req, socket, head) => {
    tunnels.add(socket);
    socket.on('close', () => tunnels.delete(socket));
    tunnel(req, socket, head, opts).catch(() => socket.destroy());
  });
  // A plain ws:// upgrade is not tunneled; Chromium sends WebSockets through a proxy with CONNECT.
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('clientError', (_err, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        for (const socket of tunnels) socket.destroy();
      }),
  };
}

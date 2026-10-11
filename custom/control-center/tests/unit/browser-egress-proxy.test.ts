import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { startEgressProxy, type EgressProxy } from '../../server/claude/browser-egress-proxy.mjs';
import { PLAYWRIGHT_MCP_PACKAGE, playwrightMcpArgs, playwrightMcpEnv } from '../../server/claude/playwright-mcp-launcher.mjs';
import { PLAYWRIGHT_MCP_PATH } from '../../server/claude/invocation.js';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';

const SECRET = 'R25-PRIVATE-PAGE-5c1f';
type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

const open: Array<{ close: () => unknown }> = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});

/** A local web server; every test reaches it as 127.0.0.1, which these tests treat as the one "public" address. */
async function serve(handler: http.RequestListener, host = '127.0.0.1'): Promise<number> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  open.push({ close: () => new Promise((resolve) => server.close(resolve)) });
  return (server.address() as net.AddressInfo).port;
}

async function proxy(lookup: Lookup, allow: (ip: string) => boolean = (ip) => ip === '127.0.0.1'): Promise<EgressProxy> {
  const p = await startEgressProxy({ lookup, allow });
  open.push(p);
  return p;
}

const fixed = (table: Record<string, string>): Lookup => async (host) => {
  if (!(host in table)) throw new Error(`ENOTFOUND ${host}`);
  return [{ address: table[host]!, family: net.isIP(table[host]!) }];
};

/** One request sent to the proxy as a browser sends it: an absolute URL for http, CONNECT for a tunnel. */
function viaProxy(port: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: url, headers: { host: new URL(url).host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function connectVia(port: number, target: string): Promise<{ status: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: target });
    req.on('connect', (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
    req.on('response', (res) => resolve({ status: res.statusCode ?? 0, socket: res.socket }));
    req.on('error', reject);
    req.end();
  });
}

describe('browser egress proxy', () => {
  it('forwards a request for a host whose every address is allowed, to the address it checked', async () => {
    const port = await serve((req, res) => res.end(`hello ${req.headers.host}`));
    const lookups: string[] = [];
    // A rebinding name: the first answer is allowed, every later one is private. The proxy must connect to the first.
    let calls = 0;
    const rebinding: Lookup = async (host) => {
      lookups.push(host);
      return [{ address: calls++ === 0 ? '127.0.0.1' : '10.0.0.1', family: 4 }];
    };
    const p = await proxy(rebinding);
    const r = await viaProxy(p.port, `http://jobs.example.test:${port}/x`);
    expect(r).toEqual({ status: 200, body: `hello jobs.example.test:${port}` });
    expect(lookups).toEqual(['jobs.example.test']);
  });

  it('refuses a request whose host resolves to a disallowed address, without connecting to it', async () => {
    let hits = 0;
    const port = await serve((_req, res) => {
      hits++;
      res.end(SECRET);
    });
    const p = await proxy(fixed({ 'intranet.example.test': '127.0.0.1', 'jobs.example.test': '127.0.0.1' }), () => false);
    const r = await viaProxy(p.port, `http://intranet.example.test:${port}/`);
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/intranet\.example\.test resolves to 127\.0\.0\.1/);
    expect(hits).toBe(0);
  });

  it('refuses a name with any disallowed address among several, a literal private address, a local name and a non-http URL', async () => {
    const mixed: Lookup = async () => [{ address: '127.0.0.1', family: 4 }, { address: '169.254.169.254', family: 4 }];
    const p = await proxy(mixed);
    expect((await viaProxy(p.port, 'http://split.example.test/')).status).toBe(403);
    expect((await viaProxy(p.port, 'http://169.254.169.254/latest/meta-data/')).status).toBe(403);
    expect((await viaProxy(p.port, 'http://[::1]:8080/')).status).toBe(403);
    expect((await viaProxy(p.port, 'http://localhost:8080/')).status).toBe(403);
    expect((await viaProxy(p.port, 'ftp://jobs.example.test/')).status).toBe(400);
  });

  it('tries each checked address in turn, so a site whose first address is unreachable still loads', async () => {
    const port = await serve((_req, res) => res.end('second address'));
    // The server listens on 127.0.0.1 only, so ::1 refuses the connection; both addresses are allowed and checked.
    const dual: Lookup = async () => [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }];
    const p = await proxy(dual, (ip) => ip === '127.0.0.1' || ip === '::1');
    expect(await viaProxy(p.port, `http://jobs.example.test:${port}/`)).toEqual({ status: 200, body: 'second address' });
    const echo = net.createServer((s) => s.end('tunnel'));
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    open.push({ close: () => new Promise((resolve) => echo.close(resolve)) });
    const t = await connectVia(p.port, `jobs.example.test:${(echo.address() as net.AddressInfo).port}`);
    expect(t.status).toBe(200);
    expect(await new Promise<string>((resolve) => t.socket.once('data', (d) => resolve(String(d))))).toBe('tunnel');
    t.socket.destroy();
  });

  it('refuses an https URL sent as a plain proxy request; https goes through a CONNECT tunnel', async () => {
    let hits = 0;
    const port = await serve((_req, res) => {
      hits++;
      res.end('cleartext');
    });
    const p = await proxy(fixed({ 'jobs.example.test': '127.0.0.1' }));
    expect((await viaProxy(p.port, `https://jobs.example.test:${port}/`)).status).toBe(400);
    expect(hits).toBe(0);
  });

  it('judges a literal address by the same rule as a resolved one', async () => {
    const port = await serve((_req, res) => res.end('literal'));
    const p = await proxy(fixed({}));
    expect(await viaProxy(p.port, `http://127.0.0.1:${port}/`)).toEqual({ status: 200, body: 'literal' });
    const strict = await proxy(fixed({}), () => false);
    expect((await viaProxy(strict.port, `http://127.0.0.1:${port}/`)).status).toBe(403);
  });

  it('refuses when the name cannot be resolved', async () => {
    const p = await proxy(fixed({}));
    const r = await viaProxy(p.port, 'http://nowhere.example.test/');
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/could not resolve nowhere\.example\.test/);
  });

  it('tunnels CONNECT to an allowed address and refuses one to a disallowed address', async () => {
    const echo = net.createServer((s) => s.pipe(s));
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    open.push({ close: () => new Promise((resolve) => echo.close(resolve)) });
    const echoPort = (echo.address() as net.AddressInfo).port;
    const p = await proxy(fixed({ 'jobs.example.test': '127.0.0.1', 'router.example.test': '192.168.1.1' }));
    const ok = await connectVia(p.port, `jobs.example.test:${echoPort}`);
    expect(ok.status).toBe(200);
    ok.socket.write('ping');
    const echoed = await new Promise<string>((resolve) => ok.socket.once('data', (d) => resolve(String(d))));
    expect(echoed).toBe('ping');
    ok.socket.destroy();
    const refused = await connectVia(p.port, 'router.example.test:443');
    expect(refused.status).toBe(403);
    refused.socket.destroy();
    expect((await connectVia(p.port, '127.0.0.2:443')).status).toBe(403);
  });

  // The R25-claude-L3-01 trigger: the session navigates to an allowed page, and the page sends the browser on to a
  // private one by a redirect, a meta refresh or a link the session clicks. Every load goes through the proxy.
  it('a browser using the proxy never loads a private page a public one redirects, refreshes or links to', async () => {
    // The private page is a real server on a loopback address other than 127.0.0.1 (::1, or 127.0.0.2 on a host
    // without IPv6), reached through a name, so only the address check stands in the way.
    const secretPage: http.RequestListener = (_req, res) => res.end(`<html><body>${SECRET}</body></html>`);
    let hiddenHost = '::1';
    const hidden = await serve(secretPage, hiddenHost).catch(() => serve(secretPage, (hiddenHost = '127.0.0.2')));
    const privateUrl = `http://intranet.example.test:${hidden}/`;
    const front = await serve((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: privateUrl });
        return res.end();
      }
      res.setHeader('content-type', 'text/html');
      if (req.url === '/refresh') return res.end(`<html><head><meta http-equiv="refresh" content="0;url=${privateUrl}"></head><body>wait</body></html>`);
      if (req.url === '/subresource') return res.end(`<html><body>page<iframe src="${privateUrl}"></iframe></body></html>`);
      res.end(`<html><body><a href="${privateUrl}">Benefits</a></body></html>`);
    });
    const p = await proxy(fixed({ 'jobs.example.test': '127.0.0.1', 'intranet.example.test': hiddenHost }));
    const browser = await chromium.launch({ proxy: { server: `http://127.0.0.1:${p.port}` } });
    open.unshift({ close: () => browser.close() });
    const page = await browser.newPage();
    const base = `http://jobs.example.test:${front}`;
    const loaded = async () => (await Promise.all([page.content(), ...page.frames().map((f) => f.content().catch(() => ''))])).join('');
    // Each case waits until the browser has asked for the private page and shows the proxy's refusal, so a check
    // that read the page too early could not pass on a leak.
    const refusedPrivatePage = async () => {
      await expect.poll(loaded, { timeout: 10_000 }).toContain('Blocked by the career-ops guard');
      const html = await loaded();
      expect(html).not.toContain(SECRET);
    };

    await page.goto(`${base}/`);
    expect(await page.content()).toContain('Benefits');
    await Promise.all([page.waitForURL(privateUrl), page.click('text=Benefits')]);
    await refusedPrivatePage();

    await page.goto(`${base}/redirect`);
    expect(page.url()).toBe(privateUrl);
    await refusedPrivatePage();

    await page.goto(`${base}/refresh`);
    await page.waitForURL(privateUrl);
    await refusedPrivatePage();

    await page.goto(`${base}/subresource`);
    await refusedPrivatePage();

    // A literal loopback address goes through the proxy too, though Chromium would bypass a proxy for it by default.
    const literal = hiddenHost === '::1' ? `http://[::1]:${hidden}/` : `http://127.0.0.2:${hidden}/`;
    await page.goto(literal);
    await refusedPrivatePage();
  });
});

describe('Playwright MCP launcher', () => {
  it('the MCP config runs the launcher, named relative to the code root the CLI runs in', () => {
    const server = JSON.parse(fs.readFileSync(PLAYWRIGHT_MCP_PATH, 'utf8')).mcpServers.playwright as { command: string; args: string[] };
    expect(server.command).toBe('node');
    expect(server.args).toHaveLength(1);
    expect(path.isAbsolute(server.args[0]!)).toBe(false);
    expect(fs.realpathSync(path.resolve(DEFAULT_CODE_ROOT, server.args[0]!))).toBe(fs.realpathSync(path.join(path.dirname(PLAYWRIGHT_MCP_PATH), 'playwright-mcp-launcher.mjs')));
  });

  it('starts the pinned MCP with every browser request sent through the proxy, the last word on the proxy', () => {
    const args = playwrightMcpArgs(4321);
    expect(PLAYWRIGHT_MCP_PACKAGE).toBe('@playwright/mcp@0.0.41');
    expect(args.slice(0, 4)).toEqual(['-y', '@playwright/mcp@0.0.41', '--browser', 'chromium']);
    expect(args.slice(-2)).toEqual(['--proxy-server', 'http://127.0.0.1:4321']);
    expect(args.some((a) => /bypass/i.test(a))).toBe(false);
  });

  it('drops every environment setting that could bypass or replace the proxy', () => {
    const env = playwrightMcpEnv({
      PATH: '/bin',
      HOME: '/home/me',
      PLAYWRIGHT_MCP_PROXY_SERVER: 'http://evil:1',
      PLAYWRIGHT_MCP_PROXY_BYPASS: '*',
      PLAYWRIGHT_MCP_CONFIG: '/tmp/c.json',
      PLAYWRIGHT_MCP_CDP_ENDPOINT: 'ws://x',
      PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK: '1',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/me' });
  });
});

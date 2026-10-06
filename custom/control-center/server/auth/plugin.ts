import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import type { ServerConfig } from '../config.js';
import { PAGE_THEME_CSS } from '../../shared/page-theme.js';

export const SESSION_COOKIE = 'cc_session';

/** Constant-time string compare; unequal lengths compare against self so timing stays flat. */
export function safeEqual(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(bb, bb);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

export function allowedHosts(publicPort: number): string[] {
  return [`127.0.0.1:${publicPort}`, `localhost:${publicPort}`];
}

export function isApiPath(url: string): boolean {
  return url.startsWith('/api/') || url === '/api' || url === '/events' || url.startsWith('/events?');
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const LOCKED_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="dark light"><title>Control Center locked</title>
<style>${PAGE_THEME_CSS}body{background:var(--bg);color:var(--text);font:14px/1.5 system-ui;display:grid;place-items:center;height:100vh;margin:0}main{max-width:28rem;padding:24px;border:1px solid var(--border);border-radius:14px;background:var(--surface-1);box-shadow:0 12px 32px -16px rgba(16,24,40,.35)}code{font-family:ui-monospace,monospace;color:var(--accent)}</style></head>
<body><main><h1 style="font-size:18px;margin:0 0 8px">Open the link from your terminal</h1>
<p>This Control Center is bound to a one-time token. Use the <code>/auth?t=...</code> URL that <code>npm start</code> printed.</p></main></body></html>`;

/** The locked page has no script and one inline style block; the app's default-src 'self' policy would block that style in built mode. */
const LOCKED_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";

export function hasSession(req: FastifyRequest, cfg: ServerConfig): boolean {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies ?? {};
  return safeEqual(cookies[SESSION_COOKIE], cfg.sessionSecret);
}

function cspFor(cfg: ServerConfig): string {
  // Vite's dev client injects an inline React refresh preamble and style tags;
  // the built client needs neither, so production stays at default-src 'self'.
  if (cfg.client === 'vite') {
    return "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'";
  }
  return "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'";
}

export async function authPlugin(app: FastifyInstance, cfg: ServerConfig): Promise<void> {
  await app.register(fastifyCookie);
  const hosts = new Set(allowedHosts(cfg.publicPort));
  const origins = new Set([...hosts].map((h) => `http://${h}`));

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.raw.url ?? '/';
    if (url === '/healthz') return;
    // DNS-rebinding defense: a browser on a foreign hostname never gets a response.
    const host = req.headers.host ?? '';
    if (!hosts.has(host)) {
      return reply.code(403).type('text/plain').send('forbidden host');
    }
    if (MUTATING.has(req.method)) {
      const origin = req.headers.origin;
      if (typeof origin !== 'string' || !origins.has(origin) || req.headers['x-cc'] !== '1') {
        return reply.code(403).type('text/plain').send('cross-origin request refused');
      }
    }
    // Only the token exchange itself: a prefix match would let /authx (the SPA fallback) through without a session.
    if (url === '/auth' || url.startsWith('/auth?')) return;
    if (hasSession(req, cfg)) return;
    if (isApiPath(url)) {
      return reply.code(401).send({ error: 'unauthenticated', hint: 'open the /auth?t= link printed by npm start' });
    }
    return reply.code(401).type('text/html').header('content-security-policy', LOCKED_CSP).send(LOCKED_HTML);
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    // A route may set a stricter policy itself (served HTML files are sandboxed).
    if (!reply.hasHeader('content-security-policy')) reply.header('Content-Security-Policy', cspFor(cfg));
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });

  app.get<{ Querystring: { t?: string } }>('/auth', async (req, reply) => {
    if (!safeEqual(req.query.t, cfg.token)) {
      return reply.code(403).type('text/plain').send('invalid token');
    }
    reply.setCookie(SESSION_COOKIE, cfg.sessionSecret, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: false,
    });
    return reply.redirect('/', 302);
  });
}

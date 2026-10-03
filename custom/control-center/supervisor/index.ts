// Supervisor: the only listener. Owns the one-time token, spawns the server
// child, proxies HTTP, SSE and WebSocket upgrades to it, runs preflight, and
// performs blue/green restarts when server/** or shared/** change (spec 3.1).
// It also serves /__recovery and /__supervisor/status itself, so Dev Chat
// change sets can be reverted even when the server child is broken.
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import chokidar from 'chokidar';
import { preflight, formatPreflight } from './preflight.js';
import { BlueGreen, type ChildHandle } from './bluegreen.js';
import { guardSessionDir, listChanges, listDevSessions, recoveryRequestAllowed, recoveryRevert } from './recovery.js';
import { resolveGuardRoot } from './guard-root.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE_ROOT = process.env.CC_CODE_ROOT ?? path.resolve(PACKAGE_ROOT, '..', '..');
const PORT = Number(process.env.CC_PORT ?? 4317);
const BUILT = process.argv.includes('--built') || process.env.CC_SERVE_BUILT === '1';
const NODE_ENV = process.env.NODE_ENV ?? 'development';
const SESSION_COOKIE = 'cc_session';

async function resolveDataRoot(): Promise<string> {
  if (process.env.CC_DATA_ROOT) return path.resolve(process.env.CC_DATA_ROOT);
  const mod = (await import(pathToFileURL(path.join(CODE_ROOT, 'path-resolver.mjs')).href)) as { getCareerOpsRoot: () => string };
  const prev = process.cwd();
  process.chdir(CODE_ROOT);
  try {
    return mod.getCareerOpsRoot();
  } finally {
    process.chdir(prev);
  }
}

function makeToken(): string {
  if (process.env.CC_TOKEN && NODE_ENV === 'test') return process.env.CC_TOKEN;
  return crypto.randomBytes(32).toString('base64url');
}

interface Child extends ChildHandle {
  proc: ChildProcess;
}

function spawnChild(env: NodeJS.ProcessEnv): Promise<Child> {
  return new Promise((resolve, reject) => {
    const tsx = path.join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsx');
    const proc = spawn(tsx, [path.join(PACKAGE_ROOT, 'server', 'index.ts')], {
      cwd: CODE_ROOT,
      env,
      stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
      shell: false,
    });
    let tail = '';
    proc.stderr?.on('data', (d: Buffer) => {
      process.stderr.write(d);
      tail = (tail + d.toString()).slice(-4000);
    });
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`server child did not report a port within 20 s\n${tail}`));
    }, 20_000);
    proc.on('message', (msg: unknown) => {
      const m = msg as { type?: string; port?: number };
      if (m?.type === 'listening' && typeof m.port === 'number') {
        clearTimeout(timer);
        resolve({
          proc,
          port: m.port,
          pid: proc.pid ?? 0,
          drain: () => {
            try {
              proc.send({ type: 'drain' });
            } catch {
              /* already gone */
            }
          },
          kill: () => proc.kill('SIGTERM'),
          stderrTail: () => tail,
        });
      }
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`server child exited before listening (code ${code}, signal ${signal})\n${tail}`));
    });
  });
}

function waitHealthy(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/healthz', headers: { host: `127.0.0.1:${PORT}` } }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error('healthz did not return 200 in time'));
      setTimeout(tick, 250);
    };
    tick();
  });
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/**
 * The recovery page's only script: it submits the revert forms with fetch so the
 * POST carries X-CC (a plain form cannot), and shows a refusal instead of
 * navigating. The CSP allows exactly this script by its hash.
 */
const RECOVERY_SCRIPT = `document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement) || form.dataset.cc !== 'revert') return;
  e.preventDefault();
  const out = document.getElementById('revert-status');
  out.textContent = 'Reverting...';
  try {
    const res = await fetch(form.action, { method: 'POST', credentials: 'same-origin', headers: { 'X-CC': '1', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(new FormData(form)).toString() });
    const text = await res.text();
    if (res.ok) location.reload();
    else out.textContent = 'Revert refused: ' + text;
  } catch (err) {
    out.textContent = 'Revert failed: ' + err.message;
  }
});`;
const RECOVERY_CSP = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${crypto.createHash('sha256').update(RECOVERY_SCRIPT).digest('base64')}'; connect-src 'self'; form-action 'self'`;

/** Static recovery page: Dev Chat change sets with revert forms, no client build needed. */
export function renderRecovery(sessionsDir: string, guardRoot: string, status: unknown): string {
  const sessions = listDevSessions(sessionsDir);
  const blocks = sessions.map((meta) => {
    const turns = listChanges(guardSessionDir(guardRoot, meta.id), meta);
    const turnHtml = turns
      .map((t) => {
        const files = t.files
          .map(
            (f) =>
              `<li><code>${escapeHtml(f.path)}</code> <span class="s">${f.status} +${f.additions} -${f.deletions}</span>` +
              (f.canRevert ? `<form method="post" action="/__recovery/revert" data-cc="revert"><input type="hidden" name="sessionId" value="${escapeHtml(meta.id)}"><input type="hidden" name="turn" value="${t.n}"><input type="hidden" name="abs" value="${escapeHtml(f.abs)}"><button>Revert file</button></form>` : '') +
              (f.patch ? `<details><summary>diff</summary><pre>${escapeHtml(f.patch)}</pre></details>` : '') +
              `</li>`,
          )
          .join('');
        return `<section><h3>Turn ${t.n}</h3>${files ? `<ul>${files}</ul>` : '<p class="s">No files changed.</p>'}<form method="post" action="/__recovery/revert" data-cc="revert"><input type="hidden" name="sessionId" value="${escapeHtml(meta.id)}"><input type="hidden" name="turn" value="${t.n}"><button>Revert whole turn</button></form></section>`;
      })
      .join('');
    return `<article><h2>${escapeHtml(meta.id)} <span class="s">${escapeHtml(meta.status)} ${escapeHtml(meta.createdAt)}</span></h2>${turnHtml || '<p class="s">No turns.</p>'}</article>`;
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Control Center recovery</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{background:#0B0D12;color:#E7EAF0;font:14px/1.5 -apple-system,Inter,sans-serif;margin:0;padding:24px;max-width:960px}
h1{font-size:22px}h2{font-size:16px;margin-top:32px}h3{font-size:14px}a{color:#8B9DFF}code,pre{font-family:ui-monospace,Menlo,monospace;font-size:12px}
pre{background:#11141A;border:1px solid #262C38;border-radius:6px;padding:8px;overflow:auto;max-height:320px}
.s{color:#A9B1C0}button{background:#171B23;color:#E7EAF0;border:1px solid #343B4A;border-radius:6px;padding:4px 10px;min-height:32px;cursor:pointer}
form{display:inline-block;margin:0 8px}li{margin:6px 0}.status{background:#11141A;border:1px solid #262C38;border-radius:10px;padding:12px}
</style></head><body><h1>Control Center recovery</h1>
<p class="s">Served by the supervisor, independent of the server child. Reverts restore the bytes a Dev Chat turn replaced (and delete files it created); a file that changed after the turn is never overwritten. <a href="/">Back to the app</a></p>
<p id="revert-status" role="alert"></p>
<div class="status"><strong>Server reload status</strong><pre>${escapeHtml(JSON.stringify(status, null, 2))}</pre></div>
${blocks.join('') || '<p class="s">No Dev Chat sessions recorded yet.</p>'}
<script>${RECOVERY_SCRIPT}</script>
</body></html>`;
}

async function main(): Promise<void> {
  const dataRoot = await resolveDataRoot();
  const sessionsDir = path.join(dataRoot, 'data', 'control-center', 'sessions');
  const guardRoot = resolveGuardRoot({ env: process.env, codeRoot: CODE_ROOT, dataRoot, home: os.homedir(), platform: process.platform });
  const claudeBin = process.env.CC_CLAUDE_BIN ?? 'claude';
  const pf = await preflight({ claudeBin, nodeVersion: process.version, env: process.env });
  const report = formatPreflight(pf);
  if (report) console.error(report);
  if (!pf.ok) process.exit(1);

  const token = makeToken();
  const sessionSecret = crypto.randomBytes(32).toString('base64url');
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CC_CODE_ROOT: CODE_ROOT,
    CC_DATA_ROOT: dataRoot,
    CC_GUARD_DIR: guardRoot,
    CC_PUBLIC_PORT: String(PORT),
    CC_TOKEN: token,
    CC_SESSION_SECRET: sessionSecret,
    CC_CLIENT: BUILT ? 'dist' : 'vite',
    CC_CLAUDE_BIN: claudeBin,
    CAREER_OPS_ROOT: dataRoot,
  };

  const first = await spawnChild(childEnv);
  await waitHealthy(first.port, 20_000);
  const bg = new BlueGreen(first, () => spawnChild(childEnv), (port) => waitHealthy(port, 20_000), { drainMs: 2000 });

  // Only the active child's exit stops the supervisor; drained children exit on purpose.
  const watchExit = (c: Child) =>
    c.proc.on('exit', (code) => {
      if (bg.active !== c) return;
      console.error(`server child exited (${code}); supervisor stopping`);
      proxy.close();
      process.exit(code ?? 1);
    });
  watchExit(first);
  bg.onStatus((s, active) => {
    if (s.state === 'ok') watchExit(active as Child);
    console.error(`[supervisor] reload ${s.state}${s.state === 'failed' ? `: ${s.error}` : ''}`);
  });

  const hostOk = (req: http.IncomingMessage) => {
    const host = req.headers.host ?? '';
    return host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;
  };
  const authed = (req: http.IncomingMessage, url: URL) => {
    const cookie = req.headers.cookie ?? '';
    const match = cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    if (match && safeEqual(match.slice(SESSION_COOKIE.length + 1), sessionSecret)) return true;
    const t = url.searchParams.get('t');
    return Boolean(t && safeEqual(t, token));
  };
  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString()));
      req.on('end', () => resolve(body));
    });

  /** Routes the supervisor answers itself; everything else is proxied. */
  const handleLocal = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    if (!url.pathname.startsWith('/__')) return false;
    if (!hostOk(req)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden host');
      return true;
    }
    if (!authed(req, url)) {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('open the token URL printed at startup first');
      return true;
    }
    const headers = { 'content-security-policy': RECOVERY_CSP, 'x-content-type-options': 'nosniff' };
    if (url.pathname === '/__supervisor/status') {
      res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify({ ...bg.status, activePid: bg.active.pid, activePort: bg.active.port }));
      return true;
    }
    if (url.pathname === '/__recovery' && req.method === 'GET') {
      if (url.searchParams.get('t')) {
        res.writeHead(302, { 'set-cookie': `${SESSION_COOKIE}=${sessionSecret}; HttpOnly; SameSite=Strict; Path=/`, location: '/__recovery' }).end();
        return true;
      }
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' }).end(renderRecovery(sessionsDir, guardRoot, bg.status));
      return true;
    }
    if (url.pathname === '/__recovery/revert' && req.method === 'POST') {
      // A SameSite=Strict cookie still rides along from any other 127.0.0.1 port, so require the app origin and X-CC too.
      if (!recoveryRequestAllowed(req.headers, PORT)) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('cross-origin request refused');
        return true;
      }
      const form = new URLSearchParams(await readBody(req));
      const r = recoveryRevert({ sessionsDir, guardRoot, ctx: { codeRoot: CODE_ROOT, dataRoot }, sessionId: form.get('sessionId') ?? '', turn: Number(form.get('turn')), abs: form.get('abs') });
      res.writeHead(r.status, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }).end(r.text);
      return true;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return true;
  };

  const proxy = http.createServer((req, res) => {
    void handleLocal(req, res).then((handled) => {
      if (handled) return;
      const upstream = http.request({ host: '127.0.0.1', port: bg.active.port, path: req.url, method: req.method, headers: req.headers }, (ures) => {
        res.writeHead(ures.statusCode ?? 502, ures.headers);
        ures.pipe(res);
      });
      upstream.on('error', (err) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`server child unavailable: ${err.message}`);
      });
      req.pipe(upstream);
    });
  });
  proxy.on('upgrade', (req, socket, head) => {
    const target = net.connect(bg.active.port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      target.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
  });

  proxy.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Stop the other process or set CC_PORT to a free port.`);
    } else {
      console.error(`Supervisor failed to listen: ${err.message}`);
    }
    bg.active.kill();
    process.exit(1);
  });

  proxy.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}/auth?t=${token}`;
    console.log(`Control Center ready: ${url}`);
    console.log(`Recovery page: http://127.0.0.1:${PORT}/__recovery`);
    if (!process.env.CC_NO_OPEN && process.platform === 'darwin') {
      execFile('open', [url], { shell: false }, () => undefined);
    }
  });

  // Blue/green restart on server or shared changes, debounced 500 ms (spec 3.1).
  if (!process.env.CC_NO_RELOAD) {
    const watcher = chokidar.watch([path.join(PACKAGE_ROOT, 'server'), path.join(PACKAGE_ROOT, 'shared')], { ignoreInitial: true });
    let debounce: NodeJS.Timeout | null = null;
    watcher.on('all', (_event, file) => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        console.error(`[supervisor] ${path.relative(PACKAGE_ROOT, file)} changed; blue/green reload`);
        void bg.reload();
      }, 500);
    });
  }

  const stop = () => {
    bg.active.kill();
    proxy.close();
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});

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
import { preflight, formatPreflight, resolveClaudeBin, claudeCandidates, testHost } from './preflight.js';
import { BlueGreen, type ChildHandle, type ReloadState } from './bluegreen.js';
import { devChatChangeInEffect, guardSessionDir, listChanges, listDevSessions, recoveryRequestAllowed, recoveryRevert } from './recovery.js';
import { resolveGuardRoot } from './guard-root.js';
import { SERVER_TREES, serverLoads, watchCoreGraph } from './core-graph.js';
import { acquireInstanceLock } from './instance-lock.js';
import { CONTRACT } from '../server/core/adapter.js';
import { dataRootFromEnv } from './data-root.js';
import { PAGE_THEME_CSS } from './page-theme.js';
import { serverChildCommand } from './child-command.js';
import { escapeHtml, plainTail, renderDownPage, renderStatus } from './down-page.js';
import { RECOVERY_SCRIPT } from './recovery-script.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE_ROOT = process.env.CC_CODE_ROOT ?? path.resolve(PACKAGE_ROOT, '..', '..');
const PORT = Number(process.env.CC_PORT ?? 4317);
const BUILT = process.argv.includes('--built') || process.env.CC_SERVE_BUILT === '1';
const NODE_ENV = process.env.NODE_ENV ?? 'development';
const SESSION_COOKIE = 'cc_session';
const CORE_ENTRIES = CONTRACT.exports.map((e) => e.module);

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
    const command = serverChildCommand(PACKAGE_ROOT);
    const proc = spawn(command.bin, command.args, {
      cwd: CODE_ROOT,
      env,
      stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
      shell: false,
    });
    // Raw for the terminal; everything that shows it (pages, replies, the status API) gets it without escape sequences.
    const tail = plainTail();
    const exited = new Promise<void>((done) => proc.once('exit', () => done()));
    proc.stderr?.on('data', (d: Buffer) => {
      process.stderr.write(d);
      tail.push(d.toString());
    });
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`server child did not report a port within 20 s\n${tail.text()}`));
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
          activate: () => {
            try {
              proc.send({ type: 'activate' });
            } catch {
              /* already gone */
            }
          },
          exited,
          kill: () => {
            proc.kill('SIGTERM');
            // A child stuck in shutdown must still exit, or the next child would never be activated.
            const hard = setTimeout(() => proc.exitCode === null && proc.signalCode === null && proc.kill('SIGKILL'), 5000);
            hard.unref();
          },
          stderrTail: tail.text,
        });
      }
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`server child exited before listening (code ${code}, signal ${signal})\n${tail.text()}`));
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

const RECOVERY_CSP = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${crypto.createHash('sha256').update(RECOVERY_SCRIPT).digest('base64')}'; connect-src 'self'; form-action 'self'`;

/** Static recovery page: Dev Chat change sets with revert forms, no client build needed. */
export function renderRecovery(sessionsDir: string, guardRoot: string, status: ReloadState): string {
  const sessions = listDevSessions(sessionsDir);
  const blocks = sessions.map((meta) => {
    const turns = listChanges(guardSessionDir(guardRoot, meta.id), meta);
    const turnHtml = turns
      .map((t) => {
        const files = t.files
          .map(
            (f) =>
              `<li><code>${escapeHtml(f.path)}</code> <span class="s">${f.status} +${f.additions} -${f.deletions}${f.error ? ` (${escapeHtml(f.error)})` : ''}</span>` +
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Control Center recovery</title><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><style>${PAGE_THEME_CSS}
body{background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,Inter,sans-serif;margin:0;padding:24px;max-width:960px}
h1{font-size:22px}h2{font-size:16px;margin-top:32px}h3{font-size:14px}a{color:var(--accent)}code,pre{font-family:ui-monospace,Menlo,monospace;font-size:12px}
pre{background:var(--surface-1);border:1px solid var(--border);border-radius:6px;padding:8px;overflow:auto;max-height:320px}
.s{color:var(--text-muted)}button{background:var(--surface-2);color:var(--text);border:1px solid var(--border-strong);border-radius:6px;padding:4px 10px;min-height:32px;cursor:pointer}
form{display:inline-block;margin:0 8px}li{margin:6px 0}.status{background:var(--surface-1);border:1px solid var(--border);border-radius:10px;padding:12px}
#revert-status{margin:12px 0}.status p{margin:8px 0}.status pre{white-space:pre-wrap;overflow-wrap:anywhere;overflow-x:hidden}#revert-status details{margin-top:6px}#revert-status pre{white-space:pre-wrap;overflow-wrap:anywhere;overflow-x:hidden}
</style></head><body><h1>Control Center recovery</h1>
<p class="s">Served by the supervisor, independent of the server child. Reverts restore the bytes a Dev Chat turn replaced (and delete files it created); a file that changed after the turn is never overwritten. <a href="/">Back to the app</a></p>
<div id="revert-status" role="alert"></div>
<div class="status"><strong>Server reload status</strong>${renderStatus(status)}<form method="post" action="/__recovery/restart" data-cc="restart"><button>Restart the server</button></form></div>
${blocks.join('') || '<p class="s">No Dev Chat sessions recorded yet.</p>'}
<script>${RECOVERY_SCRIPT}</script>
</body></html>`;
}

async function main(): Promise<void> {
  const dataRoot = await resolveDataRoot();
  // Before anything starts: a second instance on this data root would reconcile the first one's runs and sessions.
  const lock = acquireInstanceLock(dataRoot, { pid: process.pid, port: PORT });
  if (!lock.ok) {
    const who = lock.holder ? ` (pid ${lock.holder.pid}, port ${lock.holder.port})` : '';
    console.error(`Another Control Center is already running on this data root${who}: ${dataRoot}. Stop it first${lock.holder ? `, or use the one at http://127.0.0.1:${lock.holder.port}/` : ''}.`);
    process.exit(1);
  }
  process.on('exit', () => lock.release());
  const sessionsDir = path.join(dataRoot, 'data', 'control-center', 'sessions');
  const guardRoot = resolveGuardRoot({ env: process.env, codeRoot: CODE_ROOT, dataRoot, home: os.homedir(), platform: process.platform });
  const claudeBin = resolveClaudeBin(process.env.CC_CLAUDE_BIN ?? 'claude');
  // An explicit CC_CLAUDE_BIN is a decision; only an automatic pick warns about the alternatives.
  const alternatives = process.env.CC_CLAUDE_BIN ? [] : claudeCandidates('claude');
  const pf = await preflight({ claudeBin, nodeVersion: process.version, env: process.env, claudeCandidates: alternatives, ...testHost(process.env) });
  const report = formatPreflight(pf);
  if (report) console.error(report);
  if (!pf.ok) process.exit(1);

  const token = makeToken();
  const sessionSecret = crypto.randomBytes(32).toString('base64url');
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CC_CODE_ROOT: CODE_ROOT,
    CC_DATA_ROOT: dataRoot,
    // Read before CAREER_OPS_ROOT is overwritten below: only an environment-chosen root (CC_DATA_ROOT included) is pinned into launchd plists.
    CC_DATA_ROOT_FROM_ENV: process.env.CC_DATA_ROOT || dataRootFromEnv(process.env) ? '1' : '0',
    CC_GUARD_DIR: guardRoot,
    CC_PUBLIC_PORT: String(PORT),
    CC_TOKEN: token,
    CC_SESSION_SECRET: sessionSecret,
    CC_CLIENT: BUILT ? 'dist' : 'vite',
    CC_CLAUDE_BIN: claudeBin,
    CAREER_OPS_ROOT: dataRoot,
  };

  // Every child starts passive (CC_DEFER_RECONCILE): the first reconciles runs and sessions only once the port is
  // ours (a launch that cannot listen touches nothing), reload children when BlueGreen activates them.
  // A first child that cannot start (a bad Dev Chat edit under server/ or shared/) does not stop the supervisor:
  // /__recovery is how such an edit is undone, and the reload that follows the fix brings the app up.
  let first: Child | null = null;
  let startError: { error: string; stderrTail: string } | null = null;
  try {
    first = await spawnChild({ ...childEnv, CC_DEFER_RECONCILE: '1' });
    await waitHealthy(first.port, 20_000);
  } catch (err) {
    startError = { error: (err as Error).message, stderrTail: first?.stderrTail() ?? '' };
    first?.kill();
    first = null;
    console.error(`[supervisor] the server child could not start: ${startError.error}`);
    // Without reloads nothing could bring the server up again, so stop as before.
    if (process.env.CC_NO_RELOAD) process.exit(1);
    console.error('Only /__recovery is served until a reload brings the server up (a revert or Restart there, or a fix under server/ or shared/).');
  }
  const bg = new BlueGreen(first, () => spawnChild({ ...childEnv, CC_DEFER_RECONCILE: '1' }), (port) => waitHealthy(port, 20_000), { drainMs: 2000 });
  if (startError) bg.status = { state: 'failed', at: new Date().toISOString(), ...startError };

  // Drained children exit on purpose, and so does the active one when the supervisor stops. An active child that exits on
  // its own (a Dev Chat edit that throws in activate(), say) leaves no server, but the supervisor stays up with /__recovery,
  // where a revert or Restart brings it back. Without reloads nothing could, so then the supervisor stops, as before.
  let stopping = false;
  const watchExit = (c: Child) =>
    c.proc.on('exit', (code, signal) => {
      if (bg.active !== c || stopping) return;
      if (process.env.CC_NO_RELOAD) {
        console.error(`server child exited (${code}); supervisor stopping`);
        proxy.close();
        process.exit(code ?? 1);
      }
      console.error(`[supervisor] the server child exited (code ${code}, signal ${signal}) after it started. Only /__recovery is served until a reload brings the server up (a revert or Restart there, or a fix under server/ or shared/).`);
      bg.lost(c, `server child exited (code ${code}, signal ${signal}) after it started`);
    });
  if (first) watchExit(first);
  bg.onStatus((s, active) => {
    if (s.state === 'ok' && active) watchExit(active as Child);
    if (s.state === 'failed' && s.crashed) return;
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
      res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify({ ...bg.status, activePid: bg.active?.pid ?? null, activePort: bg.active?.port ?? null }));
      return true;
    }
    if (url.pathname === '/__recovery' && req.method === 'GET') {
      if (url.searchParams.get('t')) {
        res.writeHead(302, { 'set-cookie': `${SESSION_COOKIE}=${sessionSecret}; HttpOnly; SameSite=Strict; Path=/`, location: '/__recovery' }).end();
        return true;
      }
      const html = renderRecovery(sessionsDir, guardRoot, bg.status);
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' }).end(html);
      return true;
    }
    if (url.pathname === '/__recovery/revert' && req.method === 'POST') {
      // A SameSite=Strict cookie still rides along from any other 127.0.0.1 port, so require the app origin and X-CC too.
      if (!recoveryRequestAllowed(req.headers, PORT)) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('cross-origin request refused');
        return true;
      }
      const form = new URLSearchParams(await readBody(req));
      const r = recoveryRevert({ sessionsDir, guardRoot, ctx: { codeRoot: CODE_ROOT, dataRoot }, sessionId: form.get('sessionId') ?? '', turn: Number(form.get('turn')), abs: form.get('abs'), serverRunning: bg.active !== null });
      res.writeHead(r.status, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }).end(r.text);
      return true;
    }
    if (url.pathname === '/__recovery/restart' && req.method === 'POST') {
      if (!recoveryRequestAllowed(req.headers, PORT)) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('cross-origin request refused');
        return true;
      }
      // A blue/green reload: with no server running (a first start that failed) the new one takes over at once.
      const result = await bg.reload();
      const text = result.state === 'ok' ? 'the server started' : `the server still does not start: ${result.error}`;
      res.writeHead(result.state === 'ok' ? 200 : 502, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }).end(text);
      return true;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return true;
  };

  const proxy = http.createServer((req, res) => {
    // A request that throws (a disk error on /__recovery) answers 500; an unhandled rejection would exit the supervisor and the app.
    const failed = (err: unknown) => {
      console.error(`[supervisor] ${req.method} ${req.url} failed: ${(err as Error).stack ?? String(err)}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
      res.end(`supervisor error: ${(err as Error).message}`);
    };
    handleLocal(req, res).then((handled) => {
      if (handled) return;
      const active = bg.active;
      if (!active) {
        const signedIn = hostOk(req) && authed(req, new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`));
        const devChatChanged = signedIn && devChatChangeInEffect(sessionsDir, guardRoot, serverLoads(CODE_ROOT, PACKAGE_ROOT, CORE_ENTRIES), CODE_ROOT);
        const html = renderDownPage(bg.status, signedIn ? { devChatChanged } : null);
        res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'retry-after': '5' }).end(html);
        return;
      }
      const upstream = http.request({ host: '127.0.0.1', port: active.port, path: req.url, method: req.method, headers: req.headers }, (ures) => {
        res.writeHead(ures.statusCode ?? 502, ures.headers);
        ures.pipe(res);
      });
      upstream.on('error', (err) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`server child unavailable: ${err.message}`);
      });
      // A client that goes away mid-response (a video seek cancels its range request) must release the child's file too.
      res.on('close', () => {
        if (!res.writableFinished) upstream.destroy();
      });
      req.pipe(upstream);
    }).catch(failed);
  });
  proxy.on('upgrade', (req, socket, head) => {
    const active = bg.active;
    if (!active) {
      socket.destroy();
      return;
    }
    const target = net.connect(active.port, '127.0.0.1', () => {
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
    bg.active?.kill();
    process.exit(1);
  });

  proxy.listen(PORT, '127.0.0.1', () => {
    // Only the instance whose lock is still the one on disk may reconcile; one displaced while starting stops here.
    if (!lock.verify()) {
      console.error(`Another Control Center took this data root's lock while this one was starting: ${dataRoot}. This one stops.`);
      bg.active?.kill();
      process.exit(1);
    }
    // A reload that already swapped the first child out activates its replacement itself.
    if (first && bg.active === first) first.activate();
    // Without a server child, /auth is not served: the recovery link sets the session cookie itself.
    const url = first ? `http://127.0.0.1:${PORT}/auth?t=${token}` : `http://127.0.0.1:${PORT}/__recovery?t=${token}`;
    console.log(first ? `Control Center ready: ${url}` : `Control Center server did not start; recover at: ${url}`);
    console.log(`Recovery page: http://127.0.0.1:${PORT}/__recovery`);
    if (!process.env.CC_NO_OPEN && process.platform === 'darwin') {
      execFile('open', [url], { shell: false }, () => undefined);
    }
  });

  // Blue/green restart on server or shared changes, debounced 500 ms (spec 3.1). Also on a change anywhere in the import
  // graph of the core modules the server loads (custom/projects/lib.mjs and what it imports from the upstream root, edited
  // by Dev Chat or fast-forwarded by the weekly sync): only a new process loads that whole graph anew (core-graph.ts).
  if (!process.env.CC_NO_RELOAD) {
    const watcher = chokidar.watch(SERVER_TREES.map((tree) => path.join(PACKAGE_ROOT, tree)), { ignoreInitial: true });
    let debounce: NodeJS.Timeout | null = null;
    const changed = (file: string) => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        console.error(`[supervisor] ${path.relative(CODE_ROOT, file)} changed; blue/green reload`);
        void bg.reload();
      }, 500);
    };
    watcher.on('all', (_event, file) => changed(file));
    const core = await watchCoreGraph(CODE_ROOT, CORE_ENTRIES, changed);
    // The new code may import files the old one did not.
    bg.onStatus((st) => {
      if (st.state === 'ok') void core.refresh();
    });
  }

  const stop = () => {
    stopping = true;
    bg.active?.kill();
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

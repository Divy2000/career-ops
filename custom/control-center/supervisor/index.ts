// Supervisor: the only listener. Owns the one-time token, spawns the server
// child, proxies HTTP, SSE and WebSocket upgrades to it, and runs preflight.
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { preflight, formatPreflight } from './preflight.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE_ROOT = process.env.CC_CODE_ROOT ?? path.resolve(PACKAGE_ROOT, '..', '..');
const PORT = Number(process.env.CC_PORT ?? 4317);
const BUILT = process.argv.includes('--built') || process.env.CC_SERVE_BUILT === '1';
const NODE_ENV = process.env.NODE_ENV ?? 'development';

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

interface Child {
  proc: ChildProcess;
  port: number;
}

function spawnChild(env: NodeJS.ProcessEnv): Promise<Child> {
  return new Promise((resolve, reject) => {
    const tsx = path.join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsx');
    const proc = spawn(tsx, [path.join(PACKAGE_ROOT, 'server', 'index.ts')], {
      cwd: CODE_ROOT,
      env,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      shell: false,
    });
    const timer = setTimeout(() => reject(new Error('server child did not report a port within 20 s')), 20_000);
    proc.on('message', (msg: unknown) => {
      const m = msg as { type?: string; port?: number };
      if (m?.type === 'listening' && typeof m.port === 'number') {
        clearTimeout(timer);
        resolve({ proc, port: m.port });
      }
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`server child exited before listening (code ${code}, signal ${signal})`));
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

async function main(): Promise<void> {
  const dataRoot = await resolveDataRoot();
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
    CC_PUBLIC_PORT: String(PORT),
    CC_TOKEN: token,
    CC_SESSION_SECRET: sessionSecret,
    CC_CLIENT: BUILT ? 'dist' : 'vite',
    CC_CLAUDE_BIN: claudeBin,
    CAREER_OPS_ROOT: dataRoot,
  };

  const active: Child = await spawnChild(childEnv);
  await waitHealthy(active.port, 20_000);

  const proxy = http.createServer((req, res) => {
    const upstream = http.request(
      { host: '127.0.0.1', port: active.port, path: req.url, method: req.method, headers: req.headers },
      (ures) => {
        res.writeHead(ures.statusCode ?? 502, ures.headers);
        ures.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`server child unavailable: ${err.message}`);
    });
    req.pipe(upstream);
  });
  proxy.on('upgrade', (req, socket, head) => {
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
    active.proc.kill('SIGTERM');
    process.exit(1);
  });

  proxy.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}/auth?t=${token}`;
    console.log(`Control Center ready: ${url}`);
    if (!process.env.CC_NO_OPEN && process.platform === 'darwin') {
      execFile('open', [url], { shell: false }, () => undefined);
    }
  });

  const stop = () => {
    active.proc.kill('SIGTERM');
    proxy.close();
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  active.proc.on('exit', (code) => {
    console.error(`server child exited (${code}); supervisor stopping`);
    proxy.close();
    process.exit(code ?? 1);
  });
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});

// Server child entry. The supervisor spawns this with the config in env and
// proxies to the port reported over IPC.
import { buildApp } from './app.js';
import { childLifecycle } from './child-lifecycle.js';
import { configFromEnv } from './config.js';

// First, so a supervisor that is already gone (or goes while the app is built) still stops this child.
const lifecycle = childLifecycle(process, (code) => process.exit(code));
const cfg = configFromEnv();
// A blue/green reload child waits for the supervisor's activate message before it reconciles runs and sessions.
const { app, close, activate } = await buildApp(cfg, { deferReconcile: process.env.CC_DEFER_RECONCILE === '1' });
if (lifecycle.attach(close, (reason) => app.log.info({ signal: reason }, 'server child shutting down'))) {
  const childPort = Number(process.env.CC_CHILD_PORT ?? 0);
  await app.listen({ host: '127.0.0.1', port: childPort });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : childPort;
  // Startup may never have let the event loop read the channel's end, so a supervisor that died meanwhile can still look
  // connected here: the write then fails, and that stops this child like the disconnect event would.
  if (process.send) process.send({ type: 'listening', port }, undefined, undefined, (err: Error | null) => err && lifecycle.stop('disconnect'));
  else console.log(`CC_LISTENING ${port}`);

  process.on('SIGTERM', () => lifecycle.stop('SIGTERM'));
  process.on('SIGINT', () => lifecycle.stop('SIGINT'));
  process.on('message', (msg: unknown) => {
    const type = msg && typeof msg === 'object' ? (msg as { type?: string }).type : undefined;
    if (type === 'drain') lifecycle.stop('drain');
    else if (type === 'activate') activate();
  });
}

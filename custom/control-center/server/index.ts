// Server child entry. The supervisor spawns this with the config in env and
// proxies to the port reported over IPC.
import { buildApp } from './app.js';
import { configFromEnv } from './config.js';

const cfg = configFromEnv();
// A blue/green reload child waits for the supervisor's activate message before it reconciles runs and sessions.
const { app, close, activate } = await buildApp(cfg, { deferReconcile: process.env.CC_DEFER_RECONCILE === '1' });
const childPort = Number(process.env.CC_CHILD_PORT ?? 0);
await app.listen({ host: '127.0.0.1', port: childPort });
const address = app.server.address();
const port = typeof address === 'object' && address ? address.port : childPort;
if (process.send) process.send({ type: 'listening', port });
else console.log(`CC_LISTENING ${port}`);

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'server child shutting down');
  await close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('message', (msg: unknown) => {
  const type = msg && typeof msg === 'object' ? (msg as { type?: string }).type : undefined;
  if (type === 'drain') void shutdown('drain');
  else if (type === 'activate') activate();
});

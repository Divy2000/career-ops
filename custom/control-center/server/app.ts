import Fastify, { type FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import { authPlugin, hasSession } from './auth/plugin.js';
import { PACKAGE_ROOT, type ServerConfig } from './config.js';
import { systemRoutes } from './routes/system.js';

export interface BuiltApp {
  app: FastifyInstance;
  close: () => Promise<void>;
}

export async function buildApp(cfg: ServerConfig): Promise<BuiltApp> {
  const app = Fastify({ logger: cfg.nodeEnv === 'test' ? false : { level: 'info' }, trustProxy: false });
  const closers: Array<() => Promise<void>> = [];

  app.get('/healthz', async () => ({ ok: true, pid: process.pid }));
  // Called directly, not registered: its hooks must live on the root context so
  // they guard every route, including the encapsulated plugins below.
  await authPlugin(app, cfg);
  await app.register(systemRoutes, { cfg });

  if (cfg.client === 'dist') {
    const dist = path.join(PACKAGE_ROOT, 'dist');
    if (!fs.existsSync(path.join(dist, 'index.html'))) {
      throw new Error(`dist/index.html missing at ${dist}: run \`npm --prefix custom/control-center run build\` first`);
    }
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, { root: dist, wildcard: false, index: false });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.method !== 'GET' || (req.raw.url ?? '').startsWith('/api/')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.type('text/html').send(fs.readFileSync(path.join(dist, 'index.html')));
    });
  } else if (cfg.client === 'vite') {
    const { createServer } = await import('vite');
    const middie = (await import('@fastify/middie')).default;
    await app.register(middie);
    const vite = await createServer({
      configFile: path.join(PACKAGE_ROOT, 'vite.config.ts'),
      server: { middlewareMode: true, hmr: { server: app.server } },
      appType: 'spa',
      logLevel: cfg.nodeEnv === 'test' ? 'error' : 'info',
    });
    closers.push(() => vite.close());
    // Everything that is not an API route is Vite's (SPA fallback included);
    // the auth hook already rejected cookie-less requests before this point.
    app.use((req, res, next) => {
      const url = req.url ?? '/';
      if (url.startsWith('/api/') || url === '/healthz' || url.startsWith('/auth') || url === '/events') return next();
      return vite.middlewares(req, res, next);
    });
  }

  return {
    app,
    close: async () => {
      for (const c of closers) await c();
      await app.close();
    },
  };
}

export { hasSession };

import Fastify, { type FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import { authPlugin, hasSession } from './auth/plugin.js';
import { PACKAGE_ROOT, type ServerConfig } from './config.js';
import { systemRoutes } from './routes/system.js';
import { readRoutes } from './routes/read.js';
import { actionRoutes } from './routes/actions.js';
import { EventBus } from './watch/bus.js';
import { startWatcher } from './watch/watcher.js';
import { Runner } from './runner/runner.js';
import { sweepStaleInputs } from './actions/tmp-inputs.js';
import { OutsideRootsError, unresolvablePath } from './lib/atomic-write.js';
import { writeRoutes } from './routes/writes.js';
import { DailyJobWatch, dailyPidfileProbe, maybeFakeDailyProbe } from './system/daily.js';
import { execNoShell, type Exec } from './routes/system.js';
import { SessionManager, keychainTokenReader, type TokenReader } from './claude/manager.js';
import { sessionRoutes } from './routes/sessions.js';
import { policyClaim } from './domains/policyPass.js';
import { fileRoutes } from './routes/files.js';
import { projectRoutes } from './routes/projects.js';
import { sponsorshipRoutes } from './routes/sponsorship.js';
import { tutorialRoutes } from './routes/tutorials.js';
import { devchatRoutes } from './routes/devchat.js';
import { configRoutes } from './routes/config.js';
import { settingsRoutes } from './routes/settings.js';
import { pinnedNodeBin, ScheduleService } from './system/schedule.js';
import { maybeFakeLaunchd } from './system/fake-launchd.js';
import { readSettings, type AppSettings } from './domains/settings.js';

/** Action input files a crash or restart left behind are removed after a day, and CV uploads too once no session names them. */
const STALE_INPUT_MS = 24 * 3_600_000;

export interface AppDeps {
  /** Injectable process runner (tests fake ps, launchctl and plutil). */
  exec?: Exec;
  dailyPollMs?: number;
  /** Keychain token reader for Claude sessions (tests inject a constant). */
  readToken?: TokenReader;
  sessionPollMs?: number;
  /** The home directory session roots may not be or contain (tests point it at a temp root). */
  homeDir?: string;
  /**
   * Blue/green reload children start passive: they serve requests but do not
   * reconcile runs and sessions until activate(), which the supervisor sends
   * once the previous child has stopped its trackers and exited.
   */
  deferReconcile?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  bus: EventBus;
  runner: Runner;
  sessions: SessionManager;
  /** Reconcile runs and sessions left by a previous process (idempotent). */
  activate: () => void;
  close: () => Promise<void>;
}

export async function buildApp(cfg: ServerConfig, deps: AppDeps = {}): Promise<BuiltApp> {
  const exec = deps.exec ?? execNoShell;
  const app = Fastify({ logger: cfg.nodeEnv === 'test' ? false : { level: 'info' }, trustProxy: false });
  // A write refused for leaving the data root carries its reason in `error`, where the client looks for it.
  // So does a read or write of a user file whose path cannot be resolved (a symlink loop): never a 500.
  app.setErrorHandler((err, _req, reply) => {
    const errPath = (err as NodeJS.ErrnoException).path;
    const refused = err instanceof OutsideRootsError ? err : unresolvablePath(errPath ? path.relative(cfg.dataRoot, errPath) : 'the file', err);
    if (refused) return reply.code(refused.statusCode).send({ error: refused.message });
    return reply.send(err);
  });
  const closers: Array<() => Promise<void>> = [];
  const bus = new EventBus();
  // The runner reads this object live, so a settings save changes the slot cap without a restart.
  const initial = readSettings(cfg.dataRoot).settings;
  const readToken = deps.readToken ?? keychainTokenReader(exec);
  // readToken: a session run another server left queued (a blue/green reload) starts here with the token read anew.
  const runnerOpts = { claudeSlots: initial.claudeConcurrency, retention: initial.retention, readToken };
  const runner = new Runner(cfg.dataRoot, bus, runnerOpts);
  const applySettings = (s: AppSettings) => {
    runnerOpts.claudeSlots = s.claudeConcurrency;
    runner.store.setRetention(s.retention);
    // A raised cap frees slots now, not at the next run event.
    runner.reschedule();
  };
  closers.push(async () => runner.close());

  app.get('/healthz', async () => ({ ok: true, pid: process.pid }));
  // Called directly, not registered: its hooks must live on the root context so
  // they guard every route, including the encapsulated plugins below.
  await authPlugin(app, cfg);
  const daily = new DailyJobWatch(maybeFakeDailyProbe(cfg, dailyPidfileProbe(cfg.dataRoot, exec)), bus, deps.dailyPollMs);
  daily.start();
  closers.push(async () => daily.stop());
  await app.register(systemRoutes, { cfg, readToken, exec });
  await app.register(readRoutes, { cfg, bus, exec, daily });
  const sessions = new SessionManager(cfg, runner, bus, { readToken, exec, pollMs: deps.sessionPollMs, home: deps.homeDir });
  closers.push(async () => sessions.close());
  await app.register(actionRoutes, { cfg, runner, bus, exec, daily, policyPass: () => policyClaim.holder(cfg.dataRoot) });
  await app.register(sponsorshipRoutes, { cfg, exec });
  await app.register(tutorialRoutes, { cfg });
  await app.register(writeRoutes, { cfg, daily });
  let activated = false;
  const activate = () => {
    if (activated) return;
    activated = true;
    sweepStaleInputs(cfg.dataRoot, STALE_INPUT_MS);
    runner.reconcile();
    sessions.reconcile();
  };
  if (!deps.deferReconcile) activate();
  await app.register(sessionRoutes, { cfg, manager: sessions, bus, daily, dailyPending: () => runner.pending('daily.runNow').length > 0 });
  await app.register(fileRoutes, { cfg, bus });
  await app.register(projectRoutes, { cfg, bus });
  await app.register(devchatRoutes, { cfg, manager: sessions, exec });
  await app.register(configRoutes, { cfg, bus, exec });
  const schedule = new ScheduleService({ exec: maybeFakeLaunchd(cfg, exec), agentsDir: cfg.launchAgentsDir, uid: process.getuid?.() ?? 0, codeRoot: cfg.codeRoot, dataRoot: cfg.dataRoot, dataRootFromEnv: cfg.dataRootFromEnv, claudeBin: cfg.claudeBin, nodeBin: pinnedNodeBin() });
  await app.register(settingsRoutes, { cfg, bus, exec, schedule, applySettings, daily });

  if (cfg.watch) {
    const watcher = startWatcher(cfg.dataRoot, bus);
    closers.push(() => watcher.close());
  }

  if (cfg.client === 'dist') {
    const dist = cfg.distDir ?? path.join(PACKAGE_ROOT, 'dist');
    if (!fs.existsSync(path.join(dist, 'index.html'))) {
      throw new Error(`dist/index.html missing at ${dist}: run \`npm --prefix custom/control-center run build\` first`);
    }
    const fastifyStatic = (await import('@fastify/static')).default;
    // wildcard: files are looked up per request, so a rebuild while the server runs (new hashed assets, the old ones
    // deleted) is served as it is now, not as dist/ was at startup.
    // Only file paths (with an extension) are files: a page route or / falls through to the app below.
    await app.register(fastifyStatic, { root: dist, wildcard: true, index: false, allowedPath: (pathName) => /\.[a-z0-9]+$/i.test(pathName) });
    app.setNotFoundHandler(async (req, reply) => {
      const pathname = (req.raw.url ?? '/').split(/[?#]/)[0]!;
      // An asset that is not there is a 404: index.html in its place is refused as a module script and blanks the page.
      const asset = pathname.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(pathname.slice(pathname.lastIndexOf('/') + 1));
      if (req.method !== 'GET' || pathname.startsWith('/api/') || asset) {
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
    bus,
    runner,
    sessions,
    activate,
    close: async () => {
      bus.drain('server closing');
      for (const c of closers) await c();
      await app.close();
    },
  };
}

export { hasSession };

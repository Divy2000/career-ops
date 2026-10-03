import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerConfig } from '../config.js';
import { actionMetadata, findAction } from '../actions/registry.js';
import type { Runner } from '../runner/runner.js';
import { execNoShell, type Exec } from './system.js';

const SYNC_TIMEOUT_MS = 30_000;

export async function actionRoutes(app: FastifyInstance, opts: { cfg: ServerConfig; runner: Runner; exec?: Exec }): Promise<void> {
  const { cfg, runner } = opts;
  const exec = opts.exec ?? execNoShell;
  const coreEnv = { CAREER_OPS_ROOT: cfg.dataRoot, NO_COLOR: '1' };

  app.get('/api/actions', async () => actionMetadata());

  app.post<{ Params: { actionId: string }; Body: { params?: unknown } }>('/api/actions/:actionId', async (req, reply) => {
    const action = findAction(req.params.actionId);
    if (!action) return reply.code(404).send({ error: `unknown action ${req.params.actionId}` });
    const parsed = action.params.safeParse(req.body?.params ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid params', issues: parsed.error.issues });
    const cmd = action.build(parsed.data, { codeRoot: cfg.codeRoot, dataRoot: cfg.dataRoot });
    if (!action.sync) {
      const meta = runner.start({
        actionId: action.id,
        label: action.label,
        cost: action.cost,
        resources: action.resources,
        claude: action.claude,
        params: parsed.data,
        cmd: { bin: cmd.bin, args: cmd.args, cwd: cmd.cwd },
        env: { ...coreEnv, ...cmd.env },
      });
      return reply.code(202).send({ runId: meta.id });
    }
    const r = await exec(cmd.bin, cmd.args, { cwd: cmd.cwd, timeoutMs: SYNC_TIMEOUT_MS, env: { ...coreEnv, ...cmd.env } });
    let result: unknown = r.stdout;
    try {
      result = JSON.parse(r.stdout);
    } catch {
      /* plain text output */
    }
    if (r.code !== 0) {
      const status = action.exitMap?.[r.code] ?? 500;
      return reply.code(status).send({ error: `${action.id} exited ${r.code}`, exit: r.code, result, stderr: r.stderr.slice(-4000) });
    }
    return { result, stderr: r.stderr.slice(-4000) };
  });

  app.get('/api/runs', async () => runner.store.list());

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const meta = safeRead(runner, req.params.id);
    if (!meta) return reply.code(404).send({ error: 'no such run' });
    const { lines } = runner.store.readRaw(meta.id);
    return { meta, lines };
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (req, reply) => {
    const meta = safeRead(runner, req.params.id);
    if (!meta) return reply.code(404).send({ error: 'no such run' });
    return runner.cancel(meta.id);
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/events', async (req, reply) => {
    const meta = safeRead(runner, req.params.id);
    if (!meta) return reply.code(404).send({ error: 'no such run' });
    streamRun(runner, meta.id, Number(req.headers['last-event-id'] ?? 0) || 0, reply);
    await new Promise<void>((resolve) => req.raw.on('close', resolve));
    return reply;
  });
}

function safeRead(runner: Runner, id: string) {
  try {
    return runner.store.read(id);
  } catch {
    return null;
  }
}

/** Replay raw lines after Last-Event-ID, then tail by polling the file until the run ends. */
function streamRun(runner: Runner, id: string, afterSeq: number, reply: FastifyReply): void {
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
  reply.raw.write('retry: 2000\n\n');
  let seq = afterSeq;
  let offset = 0;
  let closed = false;
  const send = (type: string, data: unknown, idValue?: number) => {
    if (closed) return;
    reply.raw.write(`${idValue !== undefined ? `id: ${idValue}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const pull = () => {
    const { lines, offset: next } = runner.store.readRaw(id, seq, offset);
    offset = next;
    for (const l of lines) {
      seq = l.seq;
      send('line', l, l.seq);
    }
    const meta = runner.store.read(id);
    if (meta && meta.status !== 'running' && meta.status !== 'queued') {
      const tail = runner.store.readRaw(id, seq, offset);
      for (const l of tail.lines) {
        seq = l.seq;
        send('line', l, l.seq);
      }
      send('run.done', { status: meta.status, exitCode: meta.exitCode, signal: meta.signal });
      stop();
      reply.raw.end();
    }
  };
  const poll = setInterval(pull, 250);
  const heartbeat = setInterval(() => !closed && reply.raw.write(': ping\n\n'), 10_000);
  const stop = () => {
    closed = true;
    clearInterval(poll);
    clearInterval(heartbeat);
  };
  reply.raw.on('close', stop);
  pull();
}

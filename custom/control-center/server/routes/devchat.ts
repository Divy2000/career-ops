// Dev Chat change sets: per-turn diffs and reverts (spec 4.6), plus a
// read-only git diff of custom/**.
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import type { SessionManager } from '../claude/manager.js';
import type { Exec } from './system.js';
import { execNoShell } from './system.js';
import { listChanges, revertFile, revertTurn, RevertRefused } from '../../supervisor/recovery.js';

/** Untracked files listed by the git diff card; a build tree left under custom/ would otherwise list thousands. */
const UNTRACKED_SHOWN = 500;

export async function devchatRoutes(app: FastifyInstance, opts: { cfg: ServerConfig; manager: SessionManager; exec?: Exec }): Promise<void> {
  const { cfg, manager } = opts;
  const exec = opts.exec ?? execNoShell;

  app.get<{ Params: { id: string } }>('/api/dev/changes/:id', async (req, reply) => {
    const meta = manager.read(req.params.id);
    if (!meta) return reply.code(404).send({ error: 'no such session' });
    return { sessionId: meta.id, turns: listChanges(manager.store.guardDirOf(meta.id), meta) };
  });

  app.post<{ Body: unknown }>('/api/dev/revert', async (req, reply) => {
    const parsed = z.object({ sessionId: z.string().min(1), turn: z.number().int().positive(), abs: z.string().min(1).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    const meta = manager.read(parsed.data.sessionId);
    if (!meta) return reply.code(404).send({ error: 'no such session' });
    if (manager.isActive(meta.id) || meta.status === 'running' || meta.status === 'queued') return reply.code(409).send({ error: 'the session is still running; cancel it first' });
    const sessionDir = manager.store.guardDirOf(meta.id);
    const ctx = { codeRoot: cfg.codeRoot, dataRoot: cfg.dataRoot };
    try {
      if (parsed.data.abs) {
        const known = listChanges(sessionDir, meta).find((t) => t.n === parsed.data.turn)?.files.some((f) => f.abs === parsed.data.abs);
        if (!known) return reply.code(404).send({ error: 'that file was not changed in that turn' });
        return { reverted: [{ abs: parsed.data.abs, result: revertFile(path.join(sessionDir, 'turns', String(parsed.data.turn)), parsed.data.abs, ctx) }] };
      }
      return { reverted: revertTurn(sessionDir, meta, parsed.data.turn, ctx) };
    } catch (err) {
      if (err instanceof RevertRefused) return reply.code(err.status).send({ error: err.message, conflicts: err.conflicts });
      throw err;
    }
  });

  app.get('/api/dev/git-diff', async () => {
    const r = await exec('git', ['diff', '--stat', '--', 'custom/'], { cwd: cfg.codeRoot, timeoutMs: 15_000 });
    const full = await exec('git', ['diff', '--', 'custom/'], { cwd: cfg.codeRoot, timeoutMs: 15_000 });
    // git diff never shows untracked files, so a turn that only added files would read as clean.
    const others = await exec('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', 'custom/'], { cwd: cfg.codeRoot, timeoutMs: 15_000 });
    // The full diff is shown truncated anyway, so one that overflowed the output buffer (failed, but with output) does
    // not fail the read; one that failed with nothing to show does.
    const fullFailed = full.code !== 0 && (full.timedOut || full.stdout === '');
    const failed = [r, others].find((x) => x.code !== 0) ?? (fullFailed ? full : undefined);
    const untracked = others.code === 0 ? others.stdout.split('\0').filter(Boolean) : [];
    return {
      ok: !failed,
      stat: r.stdout,
      diff: full.stdout.slice(0, 200_000),
      untracked: untracked.slice(0, UNTRACKED_SHOWN),
      untrackedTotal: untracked.length,
      error: failed ? failed.stderr.trim() || `git exited ${failed.code}` : null,
    };
  });
}

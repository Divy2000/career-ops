// portals.yml and config/profile.yml raw editors (spec 3.4): ETag-gated writes
// that go through a temp file and the core validators before anything lands.
// Structured (comment-preserving) ops are not implemented yet; raw text keeps
// comments as typed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import type { EventBus } from '../watch/bus.js';
import { cliScriptPath } from '../core/adapter.js';
import { execNoShell, type Exec } from './system.js';
import { etagOf } from './files.js';

export const CONFIG_FILES = {
  portals: { rel: 'portals.yml', validator: 'validatePortals' as const, flag: '--file', failExit: [1], jsonFlag: false },
  profile: { rel: 'config/profile.yml', validator: 'validateProfile' as const, flag: '--profile', failExit: [2], jsonFlag: true },
} as const;

export type ConfigKey = keyof typeof CONFIG_FILES;

export interface ConfigRead {
  key: ConfigKey;
  path: string;
  kind: 'ok' | 'missing';
  raw: string;
  etag: string | null;
}

export function readConfigFile(dataRoot: string, key: ConfigKey): ConfigRead {
  const rel = CONFIG_FILES[key].rel;
  try {
    const raw = fs.readFileSync(path.join(dataRoot, rel), 'utf8');
    return { key, path: rel, kind: 'ok', raw, etag: etagOf(raw) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { key, path: rel, kind: 'missing', raw: '', etag: null };
    throw err;
  }
}

export async function configRoutes(app: FastifyInstance, opts: { cfg: ServerConfig; bus: EventBus; exec?: Exec }): Promise<void> {
  const { cfg, bus } = opts;
  const exec = opts.exec ?? execNoShell;
  const keySchema = z.enum(['portals', 'profile']);

  app.get<{ Params: { key: string } }>('/api/config/:key', async (req, reply) => {
    const key = keySchema.safeParse(req.params.key);
    if (!key.success) return reply.code(404).send({ error: `unknown config file ${req.params.key}` });
    return readConfigFile(cfg.dataRoot, key.data);
  });

  app.put<{ Params: { key: string }; Body: unknown }>('/api/config/:key', async (req, reply) => {
    const key = keySchema.safeParse(req.params.key);
    if (!key.success) return reply.code(404).send({ error: `unknown config file ${req.params.key}` });
    const body = z.object({ raw: z.string().max(2_000_000) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid body: {raw} is required (structured ops are not supported yet)', issues: body.error.issues });
    const def = CONFIG_FILES[key.data];
    const current = readConfigFile(cfg.dataRoot, key.data);
    const ifMatch = typeof req.headers['if-match'] === 'string' ? req.headers['if-match'].replace(/^"|"$/g, '') : undefined;
    const matches = current.etag === null ? ifMatch === undefined || ifMatch === '*' : ifMatch === current.etag || ifMatch === '*';
    if (!matches) return reply.code(409).send({ error: 'the file changed since you loaded it', current });

    const tmpDir = path.join(cfg.dataRoot, 'data', 'control-center', 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `${key.data}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.yml`);
    fs.writeFileSync(tmp, body.data.raw);
    try {
      const args = [cliScriptPath(cfg.codeRoot, def.validator), def.flag, tmp, ...(def.jsonFlag ? ['--json'] : [])];
      const r = await exec(process.execPath, args, { cwd: cfg.codeRoot, timeoutMs: 30_000, env: { CAREER_OPS_ROOT: cfg.dataRoot, NO_COLOR: '1' } });
      let findings: unknown = r.stdout.trim();
      if (def.jsonFlag) {
        try {
          findings = JSON.parse(r.stdout);
        } catch {
          /* keep text */
        }
      }
      if ((def.failExit as readonly number[]).includes(r.code)) {
        return reply.code(422).send({ error: `${def.validator} rejected the file (exit ${r.code}); nothing was written`, exit: r.code, findings, stderr: r.stderr.trim().slice(-2000) });
      }
      const abs = path.join(cfg.dataRoot, def.rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.renameSync(tmp, abs);
      bus.publish('data.changed', { domain: 'config' });
      return { ok: true, etag: etagOf(body.data.raw), path: def.rel, warnings: findings, validatorExit: r.code };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
}

// portals.yml, config/profile.yml and config/plugins.yml editors (spec 3.4):
// ETag-gated writes, raw text or structured ops through the yaml Document API
// (comments preserved), a temp file and the core validator before anything lands.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import type { EventBus } from '../watch/bus.js';
import { dataRootOnly, writeFileAtomic } from '../lib/atomic-write.js';
import { cliScriptPath } from '../core/adapter.js';
import { execNoShell, type Exec } from './system.js';
import { etagOf } from '../domains/files.js';
import { applyYamlOps, parseYamlDoc, yamlOpSchema, YamlOpsError, type YamlOp } from '../domains/yamlOps.js';
import { listPlugins, PLUGINS_CONFIG_REL, readPluginsConfig } from '../domains/plugins.js';

/** A file is written only when its validator exits 0 (findings then come back as warnings); any other exit, a crash or a timeout included, writes nothing. */
export const CONFIG_FILES = {
  portals: { rel: 'portals.yml', validator: 'validatePortals' as const, flag: '--file', jsonFlag: false },
  profile: { rel: 'config/profile.yml', validator: 'validateProfile' as const, flag: '--profile', jsonFlag: true },
} as const;

export type ConfigKey = keyof typeof CONFIG_FILES;

export interface ConfigRead {
  key: ConfigKey;
  path: string;
  kind: 'ok' | 'missing';
  raw: string;
  etag: string | null;
  /** Parsed JS view for the structured editors; null when the text is not valid YAML. */
  doc: unknown;
  parseError: string | null;
}

export function readConfigFile(dataRoot: string, key: ConfigKey): ConfigRead {
  const rel = CONFIG_FILES[key].rel;
  try {
    const raw = fs.readFileSync(path.join(dataRoot, rel), 'utf8');
    return { key, path: rel, kind: 'ok', raw, etag: etagOf(raw), ...parseYamlDoc(raw) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { key, path: rel, kind: 'missing', raw: '', etag: null, doc: null, parseError: null };
    throw err;
  }
}

/** If-Match semantics shared by every file write: required when the file exists, '*' always matches. */
export function etagMatches(currentEtag: string | null, header: unknown): boolean {
  const ifMatch = typeof header === 'string' ? header.replace(/^"|"$/g, '') : undefined;
  const current = currentEtag?.replace(/^"|"$/g, '') ?? null;
  if (current === null) return ifMatch === undefined || ifMatch === '*';
  return ifMatch === current || ifMatch === '*';
}

export type SaveInput = { raw: string } | { ops: YamlOp[] };
export type SaveResult = { status: 200; body: { ok: true; etag: string; path: string; warnings: unknown; validatorExit: number } } | { status: 400 | 409 | 422; body: Record<string, unknown> };

// One save at a time per file: the validator takes seconds, and two saves that both
// passed the If-Match check before it would otherwise both be written.
const saveLocks = new Map<string, Promise<unknown>>();

function withSaveLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const run = (saveLocks.get(file) ?? Promise.resolve()).then(fn, fn);
  const settled = run.catch(() => undefined);
  saveLocks.set(file, settled);
  void settled.then(() => {
    if (saveLocks.get(file) === settled) saveLocks.delete(file);
  });
  return run;
}

/** Validates through the core CLI on a temp file and renames atomically; nothing is written on failure. */
export function saveConfigFile(cfg: ServerConfig, exec: Exec, bus: EventBus, key: ConfigKey, input: SaveInput, ifMatch: unknown): Promise<SaveResult> {
  return withSaveLock(path.join(cfg.dataRoot, CONFIG_FILES[key].rel), () => saveConfigFileLocked(cfg, exec, bus, key, input, ifMatch));
}

async function saveConfigFileLocked(cfg: ServerConfig, exec: Exec, bus: EventBus, key: ConfigKey, input: SaveInput, ifMatch: unknown): Promise<SaveResult> {
  const def = CONFIG_FILES[key];
  const current = readConfigFile(cfg.dataRoot, key);
  if (!etagMatches(current.etag, ifMatch)) return { status: 409, body: { error: 'the file changed since you loaded it', current } };
  let raw: string;
  if ('raw' in input) raw = input.raw;
  else {
    try {
      raw = applyYamlOps(current.raw, input.ops);
    } catch (err) {
      if (err instanceof YamlOpsError) return { status: err.code === 'malformed' ? 422 : 400, body: { error: err.message, code: err.code } };
      throw err;
    }
  }
  const tmpDir = path.join(cfg.dataRoot, 'data', 'control-center', 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `${key}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.yml`);
  fs.writeFileSync(tmp, raw);
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
    if (r.code !== 0) {
      return { status: 422, body: { error: `${def.validator} rejected the file (exit ${r.code}); nothing was written`, exit: r.code, findings, stderr: r.stderr.trim().slice(-2000) } };
    }
    // The file may have changed while the validator ran (a session, another editor): never clobber it.
    const latest = readConfigFile(cfg.dataRoot, key);
    if (latest.etag !== current.etag) return { status: 409, body: { error: 'the file changed while it was being validated; nothing was written', current: latest } };
    writeFileAtomic(path.join(cfg.dataRoot, def.rel), raw, dataRootOnly(cfg.dataRoot));
    bus.publish('data.changed', { domain: 'config' });
    return { status: 200, body: { ok: true, etag: etagOf(raw), path: def.rel, warnings: findings, validatorExit: r.code } };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const CADENCE_KEYS = ['applied_first_days', 'applied_subsequent_days', 'applied_max_followups', 'responded_initial_days', 'responded_subsequent_days', 'interview_thankyou_days'] as const;
const cadenceSchema = z.object(Object.fromEntries(CADENCE_KEYS.map((k) => [k, z.number().int().min(0).max(365).nullable().optional()])) as Record<(typeof CADENCE_KEYS)[number], z.ZodOptional<z.ZodNullable<z.ZodNumber>>>).strict();

export async function configRoutes(app: FastifyInstance, opts: { cfg: ServerConfig; bus: EventBus; exec?: Exec }): Promise<void> {
  const { cfg, bus } = opts;
  const exec = opts.exec ?? execNoShell;
  const keySchema = z.enum(['portals', 'profile']);
  const bodySchema = z.union([z.object({ raw: z.string().max(2_000_000) }).strict(), z.object({ ops: z.array(yamlOpSchema).min(1).max(500) }).strict()]);

  app.get<{ Params: { key: string } }>('/api/config/:key', async (req, reply) => {
    const key = keySchema.safeParse(req.params.key);
    if (!key.success) return reply.code(404).send({ error: `unknown config file ${req.params.key}` });
    return readConfigFile(cfg.dataRoot, key.data);
  });

  app.put<{ Params: { key: string }; Body: unknown }>('/api/config/:key', async (req, reply) => {
    const key = keySchema.safeParse(req.params.key);
    if (!key.success) return reply.code(404).send({ error: `unknown config file ${req.params.key}` });
    const body = bodySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid body: send {raw} or {ops:[{op, path, value}]}', issues: body.error.issues });
    const r = await saveConfigFile(cfg, exec, bus, key.data, body.data, req.headers['if-match']);
    return reply.code(r.status).send(r.body);
  });

  app.get('/api/followups/cadence', async () => {
    const current = readConfigFile(cfg.dataRoot, 'profile');
    const doc = (current.doc ?? {}) as Record<string, unknown>;
    const cadence = doc.followup_cadence && typeof doc.followup_cadence === 'object' ? doc.followup_cadence : {};
    return { kind: current.kind, etag: current.etag, cadence, keys: CADENCE_KEYS, parseError: current.parseError };
  });

  app.put<{ Body: unknown }>('/api/followups/cadence', async (req, reply) => {
    const body = z.object({ cadence: cadenceSchema }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid cadence: whole days between 0 and 365, or null to remove a key', issues: body.error.issues });
    const ops: YamlOp[] = Object.entries(body.data.cadence)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => (v === null ? { op: 'delete', path: ['followup_cadence', k] } : { op: 'set', path: ['followup_cadence', k], value: v }));
    if (ops.length === 0) return reply.code(400).send({ error: 'no cadence keys given' });
    const r = await saveConfigFile(cfg, exec, bus, 'profile', { ops }, req.headers['if-match']);
    return reply.code(r.status).send(r.body);
  });

  app.put<{ Params: { id: string }; Body: unknown }>('/api/config/plugins/:id', async (req, reply) => {
    const body = z.object({ enabled: z.boolean() }).strict().safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid body: {enabled: boolean}', issues: body.error.issues });
    const known = (await listPlugins(cfg.codeRoot, cfg.dataRoot, cfg.pluginsLocalDir)).plugins.find((p) => p.id === req.params.id);
    if (!known) return reply.code(404).send({ error: `no plugin ${req.params.id}` });
    const current = readPluginsConfig(cfg.dataRoot);
    if (!etagMatches(current.etag, req.headers['if-match'])) return reply.code(409).send({ error: 'config/plugins.yml changed since you loaded it', current: { ...current, doc: undefined } });
    let raw: string;
    try {
      raw = applyYamlOps(current.raw, [{ op: 'set', path: ['plugins', known.id, 'enabled'], value: body.data.enabled }]);
    } catch (err) {
      if (err instanceof YamlOpsError) return reply.code(422).send({ error: `${err.message}; fix config/plugins.yml by hand first` });
      throw err;
    }
    writeFileAtomic(path.join(cfg.dataRoot, PLUGINS_CONFIG_REL), raw, dataRootOnly(cfg.dataRoot));
    bus.publish('data.changed', { domain: 'config' });
    return { ok: true, id: known.id, enabled: body.data.enabled, etag: etagOf(raw), path: PLUGINS_CONFIG_REL };
  });
}

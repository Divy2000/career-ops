// User-layer files (spec 3.4): allowlisted keys, sha256 ETags, If-Match on
// writes, atomic rename. Plus the CV upload used by the cv-ingest session.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import type { EventBus } from '../watch/bus.js';
import { writeFileAtomic } from '../lib/atomic-write.js';

export const USER_FILES = {
  cv: 'cv.md',
  articleDigest: 'article-digest.md',
  profileMd: 'modes/_profile.md',
  customMd: 'modes/_custom.md',
  briefMd: 'modes/_brief.md',
  voiceDna: 'voice-dna.md',
  storyBank: 'interview-prep/story-bank.md',
  activeInterviews: 'interview-prep/active-interviews.md',
} as const;

export type UserFileKey = keyof typeof USER_FILES;

export function etagOf(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export interface UserFileRead {
  key: UserFileKey;
  path: string;
  kind: 'ok' | 'missing';
  text: string;
  etag: string | null;
}

export function readUserFile(dataRoot: string, key: UserFileKey): UserFileRead {
  const rel = USER_FILES[key];
  try {
    const text = fs.readFileSync(path.join(dataRoot, rel), 'utf8');
    return { key, path: rel, kind: 'ok', text, etag: etagOf(text) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { key, path: rel, kind: 'missing', text: '', etag: null };
    throw err;
  }
}

export type WriteOutcome = { ok: true; etag: string } | { ok: false; conflict: UserFileRead };

/** If-Match must equal the current ETag; a missing file accepts no header or `*`. */
export function writeUserFile(dataRoot: string, key: UserFileKey, text: string, ifMatch: string | undefined): WriteOutcome {
  const current = readUserFile(dataRoot, key);
  const expected = current.etag;
  const matches = expected === null ? ifMatch === undefined || ifMatch === '*' : ifMatch === expected || ifMatch === '*';
  if (!matches) return { ok: false, conflict: current };
  writeFileAtomic(path.join(dataRoot, USER_FILES[key]), text);
  return { ok: true, etag: etagOf(text) };
}

const UPLOAD_TYPES: Record<string, string> = {
  'application/pdf': '.pdf',
};
// The cv-ingest session is read-only (no Bash) and Claude Code's Read handles text, images and PDF, not Word files.
const REFUSED_TYPES = ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'];
const UPLOAD_ERROR = 'the CV parser reads PDF only: export it to PDF, or pick a .md or .txt file to load the text directly';

export async function fileRoutes(app: FastifyInstance, opts: { cfg: ServerConfig; bus: EventBus }): Promise<void> {
  const { cfg, bus } = opts;
  const keySchema = z.enum(Object.keys(USER_FILES) as [UserFileKey, ...UserFileKey[]]);

  app.get<{ Params: { key: string } }>('/api/files/user/:key', async (req, reply) => {
    const key = keySchema.safeParse(req.params.key);
    if (!key.success) return reply.code(404).send({ error: `unknown user file ${req.params.key}`, keys: Object.keys(USER_FILES) });
    return readUserFile(cfg.dataRoot, key.data);
  });

  app.put<{ Params: { key: string }; Body: unknown }>('/api/files/user/:key', async (req, reply) => {
    const key = keySchema.safeParse(req.params.key);
    if (!key.success) return reply.code(404).send({ error: `unknown user file ${req.params.key}` });
    const body = z.object({ text: z.string().max(2_000_000) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
    const ifMatch = typeof req.headers['if-match'] === 'string' ? req.headers['if-match'].replace(/^"|"$/g, '') : undefined;
    const out = writeUserFile(cfg.dataRoot, key.data, body.data.text, ifMatch);
    if (!out.ok) return reply.code(409).send({ error: 'the file changed since you loaded it', current: out.conflict });
    bus.publish('data.changed', { domain: 'config' });
    return { ok: true, etag: out.etag, path: USER_FILES[key.data] };
  });

  // Binary uploads for the cv-ingest session: the file lands under the data root, never in the repo.
  for (const type of [...Object.keys(UPLOAD_TYPES), ...REFUSED_TYPES]) {
    if (!app.hasContentTypeParser(type)) app.addContentTypeParser(type, { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  }
  app.post<{ Body: Buffer; Querystring: { name?: string } }>('/api/cv/upload', { bodyLimit: 20 * 1024 * 1024 }, async (req, reply) => {
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
    const ext = UPLOAD_TYPES[type];
    if (!ext || !Buffer.isBuffer(req.body)) return reply.code(415).send({ error: UPLOAD_ERROR, accepted: Object.keys(UPLOAD_TYPES) });
    const dir = path.join(cfg.dataRoot, 'data', 'control-center', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const safeName = (req.query.name ?? 'cv').replace(/[^\w.-]+/g, '_').replace(/\.[^.]*$/, '').slice(0, 60) || 'cv';
    const abs = path.join(dir, `${Date.now()}-${safeName}${ext}`);
    fs.writeFileSync(abs, req.body);
    return { path: abs, bytes: req.body.length };
  });
}

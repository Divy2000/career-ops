// Projects library (article-digest.md): list, add, edit, delete, validate and
// convert. Every write goes through writeUserFile (ETag + If-Match, atomic
// rename); a result that would not validate is refused with 422 and nothing
// is written. /validate and /convert never write.
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { cliScriptPath } from '../core/adapter.js';
import { execNoShell, type Exec } from './system.js';
import type { ServerConfig } from '../config.js';
import type { EventBus } from '../watch/bus.js';
import { readUserFile, writeUserFile } from './files.js';
import { documentsPath, extractSourceText, projectsLib, type ProjectsLib, type ProjectsRead } from '../domains/projects.js';

const LINE = z.string().max(2000).regex(/^[^\r\n]*$/, 'one line');
const entrySchema = z.object({
  title: LINE.min(1).max(300),
  url: z.string().max(2048).nullish(),
  tagline: LINE.max(300).nullish(),
  tags: z.array(LINE.max(60)).max(30).default([]),
  kind: z.enum(['project', 'publication', 'article']).default('project'),
  dates: LINE.max(100).nullish(),
  bullets: z.array(LINE.min(1)).max(20),
  source: LINE.max(300).nullish(),
});
const textSchema = z.object({ text: z.string().max(2_000_000) });
// `source`: a document under documents/ (as intake names it, e.g. projects/x.pdf) the import came from.
const sourceField = z.string().min(1).max(300).optional();
const convertSchema = z.object({ format: z.enum(['json', 'markdown']), text: z.string().min(1).max(2_000_000), source: sourceField });
const appendSchema = z.object({ markdown: z.string().min(1).max(2_000_000), source: sourceField });
const PDF = 'application/pdf';
// Refused with intake's own reason: intake.mjs extracts PDF, Markdown and text only.
const UNSUPPORTED_UPLOADS = ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'];

/** Copy `bytes` into `dir` as `name`, reusing an identical file of that name family and never overwriting a different one. */
function storeUnique(dir: string, name: string, bytes: Buffer): { name: string; created: boolean } {
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const family = new RegExp(`^${escape(stem)}(-\\d+)?${escape(ext)}$`);
  const twin = fs.readdirSync(dir).filter((n) => family.test(n)).find((n) => fs.readFileSync(path.join(dir, n)).equals(bytes));
  if (twin) return { name: twin, created: false };
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? name : `${stem}-${n}${ext}`;
    try {
      fs.writeFileSync(path.join(dir, candidate), bytes, { flag: 'wx' });
      return { name: candidate, created: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

/** Put `Source: documents/<rel>` under the heading of one library block, replacing any Source line it carries. */
function stampSource(block: string, rel: string): string {
  const [heading, ...body] = block.split('\n');
  return [heading, `Source: documents/${rel}`, ...body.filter((l) => !/^source\s*:/i.test(l))].join('\n');
}

const ifMatchOf = (req: FastifyRequest) => (typeof req.headers['if-match'] === 'string' ? req.headers['if-match'].replace(/^"|"$/g, '') : undefined);

export async function projectRoutes(app: FastifyInstance, opts: { cfg: ServerConfig; bus: EventBus; exec?: Exec }): Promise<void> {
  const { cfg, bus } = opts;
  const exec = opts.exec ?? execNoShell;
  const docsDir = path.join(cfg.dataRoot, 'documents');

  const sourceFile = (rel: string) => documentsPath(cfg.dataRoot, rel);

  /** intake.mjs --commit for one confirmed source, the way the intake mode records a merge. */
  async function recordSource(rel: string): Promise<{ recorded: boolean; warning?: string }> {
    const r = await exec(process.execPath, [cliScriptPath(cfg.codeRoot, 'intake'), '--commit', rel], { cwd: cfg.codeRoot, timeoutMs: 60_000, env: { CAREER_OPS_ROOT: cfg.dataRoot, NO_COLOR: '1' } });
    const count = Number(r.stdout.match(/Recorded (\d+) source/)?.[1] ?? 0);
    if (r.code === 0 && count > 0) return { recorded: true };
    const why = (r.code === 0 ? 'it was already recorded, or intake extracted no text from it' : (r.stderr || r.stdout).trim().split('\n').at(-1)) ?? 'unknown error';
    return { recorded: false, warning: `documents/${rel} was not recorded as ingested: ${why}` };
  }

  for (const type of [PDF, ...UNSUPPORTED_UPLOADS]) {
    if (!app.hasContentTypeParser(type)) app.addContentTypeParser(type, { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  }
  const lib = () => projectsLib(cfg.codeRoot);

  async function view(): Promise<ProjectsRead> {
    const l = await lib();
    const file = readUserFile(cfg.dataRoot, 'articleDigest');
    const cv = readUserFile(cfg.dataRoot, 'cv').text;
    const entries = l.parseLibrary(file.text).entries.map(({ id, title, url, tagline, tags, kind, dates, source, bullets, line }) => ({
      id, title, url, tagline, tags, kind, dates, source, bullets, line, inCv: l.findCvEntry(cv, title) !== null,
    }));
    return { path: file.path, kind: file.kind, etag: file.etag, entries, validation: l.validateLibrary(file.text) };
  }

  /** Apply an edit to the current text; 404/422/409 as the edit, the validation or the ETag decide. */
  async function save(req: FastifyRequest, reply: FastifyReply, edit: (l: ProjectsLib, text: string) => string | { notFound: string }, id?: string) {
    const l = await lib();
    const current = readUserFile(cfg.dataRoot, 'articleDigest');
    let next: string | { notFound: string };
    try {
      next = edit(l, current.text);
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message, errors: [(err as Error).message] });
    }
    if (typeof next !== 'string') return reply.code(404).send({ error: next.notFound });
    const check = l.validateLibrary(next);
    if (!check.ok) return reply.code(422).send({ error: 'the library would not validate; nothing written', errors: check.errors, warnings: check.warnings });
    const out = writeUserFile(cfg.dataRoot, 'articleDigest', next, ifMatchOf(req));
    if (!out.ok) return reply.code(409).send({ error: 'the file changed since you loaded it', current: out.conflict });
    bus.publish('data.changed', { domain: 'config' });
    return { ok: true, etag: out.etag, ...(id ? { id } : {}), warnings: check.warnings };
  }

  const exists = (l: ProjectsLib, text: string, id: string) => l.parseLibrary(text).entries.some((e) => e.id === id);

  app.get('/api/projects', async () => view());

  app.post<{ Body: unknown }>('/api/projects', async (req, reply) => {
    const body = entrySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid entry', issues: body.error.issues });
    const l = await lib();
    let id: string | undefined;
    try {
      id = l.parseLibrary(l.serializeEntry(body.data)).entries[0]?.id;
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message, errors: [(err as Error).message] });
    }
    return save(req, reply, (lb, text) => lb.appendEntry(text, body.data), id);
  });

  app.put<{ Params: { id: string }; Body: unknown }>('/api/projects/:id', async (req, reply) => {
    const body = entrySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid entry', issues: body.error.issues });
    const { id } = req.params;
    return save(req, reply, (l, text) => (exists(l, text, id) ? l.replaceEntry(text, id, body.data) : { notFound: `no project ${id}` }), id);
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const { id } = req.params;
    return save(req, reply, (l, text) => (exists(l, text, id) ? l.removeEntry(text, id) : { notFound: `no project ${id}` }), id);
  });

  // Appends ready-made library markdown (the /convert proposal) as is, so digest blocks keep every line.
  app.post<{ Body: unknown }>('/api/projects/append', async (req, reply) => {
    const body = appendSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
    const source = body.data.source === undefined ? null : sourceFile(body.data.source);
    if (body.data.source !== undefined && !source) return reply.code(400).send({ error: `source must be a file under documents/: ${body.data.source}` });
    const out = await save(req, reply, (l, text) => l.appendBlock(text, body.data.markdown));
    // The Append click is the user's confirmation; only then is the document recorded as merged.
    if (!source || reply.sent) return out;
    return { ...(out as Record<string, unknown>), ...(await recordSource(source)) };
  });

  // A projects PDF is a source document: it is kept under documents/projects/ for the intake flow.
  app.post<{ Body: Buffer; Querystring: { name?: string } }>('/api/projects/upload', { bodyLimit: 20 * 1024 * 1024 }, async (req, reply) => {
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
    if (type !== PDF || !Buffer.isBuffer(req.body)) {
      return reply.code(415).send({ error: 'intake reads PDF, Markdown and text: export to PDF or .md/.txt first (pick a .md file to import Markdown directly)' });
    }
    const stem = (req.query.name ?? 'projects').replace(/[^\w.-]+/g, '_').replace(/\.[^.]*$/, '').slice(0, 60) || 'projects';
    const stored = storeUnique(path.join(docsDir, 'projects'), `${stem}.pdf`, req.body);
    const rel = `projects/${stored.name}`;
    // Read it now, as the parser will, so a PDF intake cannot read is refused up front and not left behind.
    const discard = () => {
      if (stored.created) fs.rmSync(path.join(docsDir, rel), { force: true });
    };
    let extracted: Awaited<ReturnType<typeof extractSourceText>>;
    try {
      extracted = await extractSourceText(cfg.codeRoot, cfg.dataRoot, rel);
    } catch (err) {
      discard();
      throw err;
    }
    if (!extracted.ok) {
      discard();
      return reply.code(422).send({ error: extracted.error });
    }
    return { path: rel, file: `documents/${rel}`, bytes: req.body.length, chars: extracted.text.length };
  });

  app.post<{ Body: unknown }>('/api/projects/validate', async (req, reply) => {
    const body = textSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
    const l = await lib();
    return { ...l.validateLibrary(body.data.text), entries: l.parseLibrary(body.data.text).entries.length };
  });

  // Proposes markdown to append: entries whose title is already in the library are listed, not included.
  app.post<{ Body: unknown }>('/api/projects/convert', async (req, reply) => {
    const body = convertSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
    const source = body.data.source === undefined ? null : sourceFile(body.data.source);
    if (body.data.source !== undefined && !source) return reply.code(400).send({ error: `source must be a file under documents/: ${body.data.source}` });
    const l = await lib();
    let entries: Array<{ title: string; block: string }>;
    let warnings: string[];
    if (body.data.format === 'json') {
      let data: unknown;
      try {
        data = JSON.parse(body.data.text);
      } catch (err) {
        return reply.code(422).send({ error: `not valid JSON: ${(err as Error).message}` });
      }
      try {
        const converted = l.convertJsonProjects(data);
        warnings = converted.warnings;
        entries = converted.entries.map((e) => ({ title: e.title, block: l.serializeEntry(e) }));
      } catch (err) {
        return reply.code(422).send({ error: (err as Error).message });
      }
    } else {
      warnings = l.validateLibrary(body.data.text).warnings;
      entries = l.parseLibrary(body.data.text).entries.map((e) => ({ title: e.title, block: body.data.text.slice(e.start, e.end) }));
    }
    const current = readUserFile(cfg.dataRoot, 'articleDigest').text;
    const have = new Set(l.parseLibrary(current).entries.map((e) => l.titleKey(e.title)));
    const fresh = entries.filter((e) => !have.has(l.titleKey(e.title)));
    const blocks = fresh.map((e) => (source ? stampSource(e.block, source) : e.block));
    const markdown = blocks.length ? `${blocks.join('\n\n---\n\n')}\n` : '';
    // The preview's own errors carry its line numbers; the merged check catches what only the append would break.
    let errors = markdown ? l.validateLibrary(markdown).errors : [];
    if (markdown && errors.length === 0) {
      const merged = l.validateLibrary(l.appendBlock(current, markdown));
      if (!merged.ok) errors = merged.errors.map((e) => `after the append, article-digest.md: ${e}`);
    }
    return {
      markdown,
      entries: entries.map((e) => ({ title: e.title })),
      duplicates: entries.filter((e) => have.has(l.titleKey(e.title))).map((e) => e.title),
      warnings,
      errors,
    };
  });
}

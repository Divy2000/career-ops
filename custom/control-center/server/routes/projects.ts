// Projects library (article-digest.md): list, add, edit, delete, validate and
// convert. Every write goes through writeUserFile (ETag + If-Match, atomic
// rename); a result that would not validate is refused with 422 and nothing
// is written. /validate and /convert never write.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import type { EventBus } from '../watch/bus.js';
import { readUserFile, writeUserFile } from './files.js';
import { projectsLib, type ProjectsLib } from '../domains/projects.js';

const LINE = z.string().max(2000).regex(/^[^\r\n]*$/, 'one line');
const entrySchema = z.object({
  title: LINE.min(1).max(300),
  url: z.string().max(2048).nullish(),
  tagline: LINE.max(300).nullish(),
  tags: z.array(LINE.max(60)).max(30).default([]),
  kind: z.enum(['project', 'publication', 'article']).default('project'),
  dates: LINE.max(100).nullish(),
  bullets: z.array(LINE.min(1)).max(20),
});
const textSchema = z.object({ text: z.string().max(2_000_000) });
const convertSchema = z.object({ format: z.enum(['json', 'markdown']), text: z.string().min(1).max(2_000_000) });

const ifMatchOf = (req: FastifyRequest) => (typeof req.headers['if-match'] === 'string' ? req.headers['if-match'].replace(/^"|"$/g, '') : undefined);

export async function projectRoutes(app: FastifyInstance, opts: { cfg: ServerConfig; bus: EventBus }): Promise<void> {
  const { cfg, bus } = opts;
  const lib = () => projectsLib(cfg.codeRoot);

  async function view() {
    const l = await lib();
    const file = readUserFile(cfg.dataRoot, 'articleDigest');
    const cv = readUserFile(cfg.dataRoot, 'cv').text;
    const entries = l.parseLibrary(file.text).entries.map(({ id, title, url, tagline, tags, kind, dates, bullets, line }) => ({
      id, title, url, tagline, tags, kind, dates, bullets, line, inCv: l.findCvEntry(cv, title) !== null,
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
    const id = l.parseLibrary(l.serializeEntry(body.data)).entries[0]?.id;
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
    const l = await lib();
    let entries: Array<{ title: string; block: string }>;
    let warnings: string[];
    let errors: string[] = [];
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
      const check = l.validateLibrary(body.data.text);
      errors = check.errors;
      warnings = check.warnings;
      entries = l.parseLibrary(body.data.text).entries.map((e) => ({ title: e.title, block: body.data.text.slice(e.start, e.end) }));
    }
    const have = new Set(l.parseLibrary(readUserFile(cfg.dataRoot, 'articleDigest').text).entries.map((e) => l.titleKey(e.title)));
    const fresh = entries.filter((e) => !have.has(l.titleKey(e.title)));
    return {
      markdown: fresh.length ? `${fresh.map((e) => e.block).join('\n\n---\n\n')}\n` : '',
      entries: entries.map((e) => ({ title: e.title })),
      duplicates: entries.filter((e) => have.has(l.titleKey(e.title))).map((e) => e.title),
      warnings,
      errors,
    };
  });
}

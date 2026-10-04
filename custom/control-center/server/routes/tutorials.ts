import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import { listTutorials, openMedia, parseRange, readSubtitleText, srtToVtt } from '../domains/tutorials.js';

export async function tutorialRoutes(app: FastifyInstance, opts: { cfg: ServerConfig }): Promise<void> {
  const { cfg } = opts;

  app.get('/api/tutorials', async () => listTutorials(cfg.dataRoot));

  app.get<{ Params: { id: string; file: string } }>('/api/tutorials/:id/media/:file', async (req, reply) => {
    const media = openMedia(cfg.dataRoot, req.params.id, req.params.file);
    if (!media.ok) return reply.code(media.status).send({ error: media.error });
    reply.header('cache-control', 'private, no-cache');
    if (media.convertSrt) {
      const text = readSubtitleText(media.abs, media.size);
      if (text === null) return reply.code(413).send({ error: 'subtitle file is too large' });
      return reply.type(media.type).send(srtToVtt(text));
    }
    reply.header('accept-ranges', 'bytes');
    const range = parseRange(req.headers.range, media.size);
    if (range.kind === 'unsatisfiable') return reply.code(416).header('content-range', `bytes */${media.size}`).send({ error: 'range not satisfiable' });
    reply.type(media.type);
    if (range.kind === 'none') return reply.header('content-length', media.size).send(fs.createReadStream(media.abs));
    return reply
      .code(206)
      .header('content-range', `bytes ${range.start}-${range.end}/${media.size}`)
      .header('content-length', range.end - range.start + 1)
      .send(fs.createReadStream(media.abs, { start: range.start, end: range.end }));
  });
}

import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import { parseCompanyQuery } from '../../shared/companyQuery.js';
import { lookupCompany, searchCompanies } from '../domains/sponsorshipLookup.js';
import { execNoShell, type Exec } from './system.js';

export async function sponsorshipRoutes(app: FastifyInstance, opts: { cfg: ServerConfig; exec?: Exec }): Promise<void> {
  const { cfg } = opts;
  const ctx = { cfg, exec: opts.exec ?? execNoShell, env: { CAREER_OPS_ROOT: cfg.dataRoot, NO_COLOR: '1' } };

  app.get<{ Querystring: { company?: string } }>('/api/sponsorship/lookup', async (req, reply) => {
    const q = parseCompanyQuery(req.query.company);
    if (!q.ok) return reply.code(400).send({ error: q.error });
    return lookupCompany(ctx, q.value);
  });

  app.get<{ Querystring: { q?: string } }>('/api/sponsorship/search', async (req, reply) => {
    const q = parseCompanyQuery(req.query.q);
    if (!q.ok) return reply.code(400).send({ error: q.error });
    return searchCompanies(ctx, q.value);
  });
}

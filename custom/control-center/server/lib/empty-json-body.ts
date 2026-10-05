import type { FastifyInstance } from 'fastify';

/**
 * Routes registered inside `register` accept a JSON content-type with an empty body (a button that posts nothing),
 * which Fastify's default parser rejects with 400. A non-empty body still goes through the default secure parser.
 * The parser is scoped to the child context, so every other route keeps the strict default.
 */
export async function withEmptyJsonBody(app: FastifyInstance, register: (scope: FastifyInstance) => void): Promise<void> {
  await app.register(async (scope) => {
    const strict = scope.getDefaultJsonParser('error', 'error');
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      if ((body as string).length === 0) {
        done(null, undefined);
        return;
      }
      strict(req, body as string, done);
    });
    register(scope);
  });
}

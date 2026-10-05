import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { makePdf } from '../helpers/pdf.js';
import type * as ProjectsDomain from '../../server/domains/projects.js';

// The extractor throws instead of returning { ok: false } (a bug or an unexpected failure inside it).
vi.mock('../../server/domains/projects.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ProjectsDomain>()),
  extractSourceText: vi.fn(async () => {
    throw new Error('extractor blew up');
  }),
}));

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

const upload = (name: string, body: Buffer) => t.app.inject({ method: 'POST', url: `/api/projects/upload?name=${name}`, headers: { ...t.authedWrite, 'content-type': 'application/pdf' }, payload: body });
const projectsDir = () => path.join(t.cfg.dataRoot, 'documents', 'projects');

describe('an upload whose extraction throws', () => {
  it('answers with an error and does not leave the new file behind', async () => {
    const res = await upload('boom.pdf', makePdf(['x']));
    expect(res.statusCode).toBe(500);
    expect(fs.existsSync(path.join(projectsDir(), 'boom.pdf'))).toBe(false);
  });

  it('keeps an identical file that was already there', async () => {
    const pdf = makePdf(['kept']);
    fs.mkdirSync(projectsDir(), { recursive: true });
    fs.writeFileSync(path.join(projectsDir(), 'kept.pdf'), pdf);
    expect((await upload('kept.pdf', pdf)).statusCode).toBe(500);
    expect(fs.readFileSync(path.join(projectsDir(), 'kept.pdf')).equals(pdf)).toBe(true);
  });
});

// A sponsorship check names its company file data/immigration/companies/<slug>.md, and custom/immigration/lib.mjs
// companySlug() (run by freshness.mjs, the check's first step) throws when nothing is left of the name after slugging.
// A check for such a name ("Ltd", "LLC", "株式会社") would be paid for and never save its file, so it is refused before
// any turn runs (R25-FU-03).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { companySlug } from '../../../immigration/lib.mjs';
import { copyFixtureRoot, makeTestApp, type TestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

let app: TestApp;
beforeAll(async () => {
  app = await makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
});
afterAll(async () => {
  await app.close();
});
const start = (name: string) =>
  app.app.inject({ method: 'POST', url: '/api/sessions', headers: app.authedWrite, payload: { mode: 'sponsorship-check', target: { type: 'company', value: name }, prompt: `Run a sponsorship check for ${name}.` } });

describe('a sponsorship check for a name with no company-file slug', () => {
  for (const name of ['Ltd', ' LLC. ', '株式会社', 'Inc. - Co.']) {
    it(`given the company "${name}", when a check starts, then it is refused with 400 saying why and how to fix it, and no session is created`, async () => {
      expect(() => companySlug(name)).toThrow(/empty after normalization/);
      const before = app.sessions.list().length;
      const res = await start(name);
      expect(res.statusCode, res.body).toBe(400);
      const error = (res.json() as { error: string }).error;
      expect(error).toContain(`"${name.trim()}"`);
      expect(error).toMatch(/company file/);
      expect(error).toMatch(/distinctive name/);
      expect(app.sessions.list().length).toBe(before);
    });
  }
});

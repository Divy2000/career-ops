// A sponsorship check writes data/immigration/companies/** for its company, so a second check of the same company
// while one is live (a second tab, or a raw POST past the web launcher's hold) would be a second paid session writing
// the same files (R24-FU-01).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFixtureRoot, makeTestApp, type TestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

const call = (app: TestApp, payload: Record<string, unknown>) => app.app.inject({ method: 'POST', url: '/api/sessions', headers: app.authedWrite, payload });
const freshApp = () => makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
// A started run keeps writing into its data root after app.close(): cancel open turns and wait for them to end.
const quiet = async (app: TestApp) => {
  const safe = () => {
    const out: Array<{ id: string; status: string; turns: Array<{ endedAt: string | null }> }> = [];
    const dir = path.join(app.cfg.dataRoot, 'data', 'control-center', 'sessions');
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return out; }
    for (const n of names) {
      try { const m = app.sessions.read(n); if (m) out.push(m); } catch { /* unreadable or half-written meta */ }
    }
    return out;
  };
  const open = (s: { turns: Array<{ endedAt: string | null }> }) => { const last = s.turns.at(-1); return !!last && !last.endedAt; };
  for (const s of safe()) if (open(s) && (s.status === 'running' || s.status === 'queued')) app.sessions.cancel(s.id);
  for (let i = 0; i < 400 && safe().some(open); i += 1) await new Promise((r) => setTimeout(r, 25));
};
const company = (value: string) => ({ type: 'company' as const, value });
const check = (name: string) => ({ mode: 'sponsorship-check', target: company(name), prompt: `Run a sponsorship check for ${name}.` });

function liveSession(app: TestApp, mode: string, name: string, status: 'queued' | 'running' | 'awaiting_user') {
  const meta = app.sessions.store.create({ mode, policyClass: mode === 'sponsorship-check' ? 'sponsorship-check' : 'outreach', target: company(name), model: null, reportNum: null });
  app.sessions.store.setStatus(meta.id, status);
  return meta;
}

describe('a live sponsorship check holds its company against a second check', () => {
  for (const status of ['queued', 'running', 'awaiting_user'] as const) {
    it(`given a ${status} sponsorship check for Acme, when a second check names " acme ", then it is refused with 409 naming the live session`, async () => {
      const app = await freshApp();
      try {
        const live = liveSession(app, 'sponsorship-check', 'Acme', status);
        const res = await call(app, check(' acme '));
        expect(res.statusCode, res.body).toBe(409);
        const error = (res.json() as { error: string }).error;
        expect(error).toContain(live.id);
        expect(error).not.toMatch(/evaluating/);
      } finally {
        await quiet(app);
        await app.close();
      }
    });
  }

  it('given a live sponsorship check for Acme, when a check names Globex, then it starts', async () => {
    const app = await freshApp();
    try {
      liveSession(app, 'sponsorship-check', 'Acme', 'running');
      const res = await call(app, check('Globex'));
      expect(res.statusCode, res.body).not.toBe(409);
      expect(res.statusCode, res.body).toBeLessThan(300);
    } finally {
      await quiet(app);
      await app.close();
    }
  });

  it('given a finished sponsorship check for Acme, when a second check names Acme, then it starts', async () => {
    const app = await freshApp();
    try {
      liveSession(app, 'sponsorship-check', 'Acme', 'running');
      const done = app.sessions.store.list()[0]!;
      app.sessions.store.setStatus(done.id, 'done');
      const res = await call(app, check('Acme'));
      expect(res.statusCode, res.body).toBeLessThan(300);
    } finally {
      await quiet(app);
      await app.close();
    }
  });

  it('given a live sponsorship check for Acme Corp, when a second check spells it "acme   corp", then it is refused with 409', async () => {
    const app = await freshApp();
    try {
      const live = liveSession(app, 'sponsorship-check', 'Acme Corp', 'running');
      const res = await call(app, check('acme   corp'));
      expect(res.statusCode, res.body).toBe(409);
      expect((res.json() as { error: string }).error).toContain(live.id);
    } finally {
      await quiet(app);
      await app.close();
    }
  });

  it('given a live deep research session on company Acme, when a second deep research names Acme, then it starts (only sponsorship checks are held per company)', async () => {
    const app = await freshApp();
    try {
      liveSession(app, 'deep', 'Acme', 'running');
      const res = await call(app, { mode: 'deep', target: company('Acme'), prompt: 'Research Acme.' });
      expect(res.statusCode, res.body).toBeLessThan(300);
    } finally {
      await quiet(app);
      await app.close();
    }
  });

  it('given a live session of another mode on company Acme, when a sponsorship check names Acme, then it starts', async () => {
    const app = await freshApp();
    try {
      liveSession(app, 'deep', 'Acme', 'running');
      const res = await call(app, check('Acme'));
      expect(res.statusCode, res.body).toBeLessThan(300);
    } finally {
      await quiet(app);
      await app.close();
    }
  });
});

// A fork of a sponsorship check starts a second paid session writing the same company's files (R24-FU-01b); a reply
// continues the same session, so it is not a duplicate.
describe('a fork of a sponsorship check is held by a live check of its company', () => {
  const fork = (app: TestApp, id: string) => app.app.inject({ method: 'POST', url: `/api/sessions/${id}/fork`, headers: app.authedWrite, payload: { prompt: 'Check again.' } });
  const reply = (app: TestApp, id: string) => app.app.inject({ method: 'POST', url: `/api/sessions/${id}/turns`, headers: app.authedWrite, payload: { prompt: 'Go on.' } });
  const withConversation = (app: TestApp, name: string, status: 'done' | 'awaiting_user') => {
    const meta = liveSession(app, 'sponsorship-check', name, 'running');
    app.sessions.store.markConversationStarted(meta.id);
    app.sessions.store.setStatus(meta.id, status);
    return meta;
  };

  it('given a finished check of Acme and another live check of Acme, when the finished one is forked, then it is refused with 409 naming the live session', async () => {
    const app = await freshApp();
    try {
      const src = withConversation(app, 'Acme', 'done');
      const live = liveSession(app, 'sponsorship-check', 'acme', 'running');
      const res = await fork(app, src.id);
      expect(res.statusCode, res.body).toBe(409);
      expect((res.json() as { error: string }).error).toBe(`session ${live.id} is already running a sponsorship check for Acme`);
    } finally {
      await quiet(app);
      await app.close();
    }
  });

  it('given a check of Acme waiting for the user, when it is forked, then it is refused with 409 since the source would go on beside the copy', async () => {
    const app = await freshApp();
    try {
      const src = withConversation(app, 'Acme', 'awaiting_user');
      const res = await fork(app, src.id);
      expect(res.statusCode, res.body).toBe(409);
      expect((res.json() as { error: string }).error).toBe(`session ${src.id} is already running a sponsorship check for Acme`);
    } finally {
      await quiet(app);
      await app.close();
    }
  });

  it('given a finished check of Acme and no live check of it, when it is forked, then the fork starts', async () => {
    const app = await freshApp();
    try {
      const src = withConversation(app, 'Acme', 'done');
      const res = await fork(app, src.id);
      expect(res.statusCode, res.body).toBe(202);
    } finally {
      await quiet(app);
      await app.close();
    }
  });

  it('given a fork of a check of Acme that never got its own conversation and another live check of Acme, when the user replies to the fork, then it is refused with 409 since the reply forks the source again', async () => {
    const app = await freshApp();
    try {
      const src = withConversation(app, 'Acme', 'done');
      const copy = app.sessions.store.create({ mode: 'sponsorship-check', policyClass: 'sponsorship-check', target: company('Acme'), model: null, forkedFrom: src.id, forkPending: true });
      app.sessions.store.setStatus(copy.id, 'error');
      const live = liveSession(app, 'sponsorship-check', 'Acme', 'running');
      const res = await reply(app, copy.id);
      expect(res.statusCode, res.body).toBe(409);
      expect((res.json() as { error: string }).error).toBe(`session ${live.id} is already running a sponsorship check for Acme`);
    } finally {
      await quiet(app);
      await app.close();
    }
  });

  it('given a check of Acme waiting for the user, when the user replies to it, then the reply is not refused as a duplicate', async () => {
    const app = await freshApp();
    try {
      const src = withConversation(app, 'Acme', 'awaiting_user');
      const res = await reply(app, src.id);
      expect(res.statusCode, res.body).toBe(202);
    } finally {
      await quiet(app);
      await app.close();
    }
  });
});

// The company key is the slug the check writes its file under, so two spellings of one company file collide (R24-FU-01c).
describe('the sponsorship check company key is the company-file slug', () => {
  it('given a live check of "Acme, Inc.", when a check names "Acme Inc", then it is refused with 409 naming the live session', async () => {
    const app = await freshApp();
    try {
      const live = liveSession(app, 'sponsorship-check', 'Acme, Inc.', 'running');
      const res = await call(app, check('Acme Inc'));
      expect(res.statusCode, res.body).toBe(409);
      expect((res.json() as { error: string }).error).toContain(live.id);
    } finally {
      await quiet(app);
      await app.close();
    }
  });
});

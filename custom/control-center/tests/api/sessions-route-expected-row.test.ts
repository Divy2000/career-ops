// A start on a tracker row can name the application the page showed under that number (`target.expect`). A reindex can
// move another application under the number before the click lands, so the start is refused unless the row the server
// pins is that application (sessions.invariants.md, 3 and 10; R35-feat-a-L2-01, R35-feat-a-L1-01).
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { runsEnded } from '../helpers/runs.js';
import type { SessionMeta } from '../../server/claude/sessions.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  const open = (s: SessionMeta) => !!s.turns.at(-1) && !s.turns.at(-1)!.endedAt;
  for (const s of t.sessions.store.list()) if (open(s) && (s.status === 'running' || s.status === 'queued')) t.sessions.cancel(s.id);
  await t.close();
  await runsEnded(t.cfg.dataRoot);
});

const GLOBEX = { company: 'Globex Payments', role: 'Staff Software Engineer', report: 3 };
const start = (payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url: '/api/sessions', headers: t.authedWrite, payload });
const count = () => t.sessions.store.list().length;

describe('a start that names the application it expects under the row number', () => {
  type Case = { name: string; mode: string; value: string; expect: unknown; code: number };
  const cases: Case[] = [
    { name: 'the row is the expected application', mode: 'advisor', value: '3', expect: GLOBEX, code: 202 },
    { name: 'the page saw the row before its report was linked', mode: 'advisor', value: '3', expect: { ...GLOBEX, report: null }, code: 202 },
    { name: 'a tailored CV for the expected application', mode: 'pdf', value: '6', expect: { company: 'Vandelay Systems', role: 'Senior Python Engineer', report: 6 }, code: 202 },
    { name: 'a reindex moved another company under the number', mode: 'pdf', value: '1', expect: { ...GLOBEX, report: null }, code: 409 },
    { name: 'the same company and role under another report', mode: 'advisor', value: '3', expect: { ...GLOBEX, report: 42 }, code: 409 },
    { name: 'another role at the company', mode: 'advisor', value: '3', expect: { ...GLOBEX, role: 'Backend Engineer' }, code: 409 },
    { name: 'no row is under the number any more', mode: 'pdf', value: '999', expect: GLOBEX, code: 409 },
  ];
  for (const c of cases) {
    it(`given ${c.name}, when the ${c.mode} session starts on #${c.value}, then it answers ${c.code}`, async () => {
      const before = count();
      const res = await start({ mode: c.mode, target: { type: 'app', value: c.value, expect: c.expect }, prompt: `Work on tracker row #${c.value}` });
      expect(res.statusCode, res.body).toBe(c.code);
      if (c.code === 202) {
        const target = (res.json() as SessionMeta).target as Record<string, unknown>;
        // The expectation is a check, not part of the stored target.
        expect(target).not.toHaveProperty('expect');
        expect(target.row).toBeDefined();
        expect(count()).toBe(before + 1);
      } else {
        expect((res.json() as { error: string }).error).toMatch(new RegExp(`#${c.value}\\b`));
        expect(count()).toBe(before);
      }
    });
  }

  it('given no expected application, when a session starts on the row, then it starts as before', async () => {
    const res = await start({ mode: 'advisor', target: { type: 'app', value: '2' }, prompt: 'Prepare me for #2' });
    expect(res.statusCode, res.body).toBe(202);
  });

  const bad: { name: string; target: unknown }[] = [
    { name: 'an expectation on a URL target', target: { type: 'url', value: 'https://example.com/jobs/1', expect: GLOBEX } },
    { name: 'an expectation without a role', target: { type: 'app', value: '3', expect: { company: 'Globex Payments', report: 3 } } },
    { name: 'an expectation whose report is not a number', target: { type: 'app', value: '3', expect: { ...GLOBEX, report: '3' } } },
  ];
  for (const c of bad) {
    it(`given ${c.name}, when the session starts, then it is refused with 400 and nothing starts`, async () => {
      const before = count();
      const res = await start({ mode: 'advisor', target: c.target, prompt: 'Prepare me' });
      expect(res.statusCode, res.body).toBe(400);
      expect(count()).toBe(before);
    });
  }

  it('given the tracker reindexed between two starts with the same expectation, then only the start before the reindex runs', async () => {
    const file = path.join(t.cfg.dataRoot, 'data', 'applications.md');
    const original = fs.readFileSync(file, 'utf8');
    const expectRow = { company: 'Northwind Analytics', role: 'ML Platform Engineer', report: 2 };
    try {
      const first = await start({ mode: 'advisor', target: { type: 'app', value: '2', expect: expectRow }, prompt: 'Prepare me for #2' });
      expect(first.statusCode, first.body).toBe(202);
      // Row 1 deleted: every later row moves up one number, so Globex now sits under #2.
      const reindexed = original
        .split('\n')
        .filter((l) => !/^\| 1 \|/.test(l))
        .map((l) => l.replace(/^\| (\d+) \|/, (_, n: string) => `| ${Number(n) - 1} |`))
        .join('\n');
      fs.writeFileSync(file, reindexed);
      const before = count();
      const second = await start({ mode: 'advisor', target: { type: 'app', value: '2', expect: expectRow }, prompt: 'Prepare me for #2' });
      expect(second.statusCode, second.body).toBe(409);
      expect(count()).toBe(before);
    } finally {
      fs.writeFileSync(file, original);
    }
  });
});

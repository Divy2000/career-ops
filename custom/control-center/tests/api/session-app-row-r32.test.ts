// An application's Sessions tab lists the sessions targeting its row number. A deleted row's number can be handed to a
// later addition, so a session pins the row it was started on (company, role, report), and the page that now holds the
// number does not list the deleted row's sessions (R31-feat-c-L2-01b).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../helpers/app.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

async function startedTarget(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await t.app.inject({ method: 'POST', url: '/api/sessions', headers: t.authedWrite, payload });
  expect(res.statusCode, res.body).toBe(202);
  return res.json().target as Record<string, unknown>;
}

describe('a session started on a tracker row', () => {
  it('Given row 3 exists, When a session targets it, Then the session records the row it was started on', async () => {
    const target = await startedTarget({ mode: 'advisor', target: { type: 'app', value: '3' }, prompt: 'Prepare me for #3' });
    expect(target).toEqual({ type: 'app', value: '3', row: { company: 'Globex Payments', role: 'Staff Software Engineer', report: 3 } });
  });

  it('Given a client that sends its own row identity, When the session starts, Then the tracker decides the row, not the client', async () => {
    const target = await startedTarget({ mode: 'advisor', target: { type: 'app', value: '3', row: { company: 'Beta Labs', role: 'x', report: 99 } }, prompt: 'Prepare me for #3' });
    expect(target.row).toEqual({ company: 'Globex Payments', role: 'Staff Software Engineer', report: 3 });
  });

  it('Given no row under the number, When a session targets it, Then no row is recorded', async () => {
    const target = await startedTarget({ mode: 'advisor', target: { type: 'app', value: '999' }, prompt: 'Prepare me for #999' });
    expect(target).toEqual({ type: 'app', value: '999' });
  });
});

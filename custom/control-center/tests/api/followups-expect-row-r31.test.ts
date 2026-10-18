// Follow-up Log and Pin name the application by tracker row number. A tracker delete reindexes the rows, so a number the
// page read can name another application by the time it is written: the expected row is checked, as tracker.setStatus
// and the follow-up Delete do, and a mismatch is refused as stale with nothing written (R31-feat-a-X-01).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';

let t: TestApp;
let file: string;
beforeAll(async () => {
  t = await makeTestApp();
  file = path.join(t.cfg.dataRoot, 'data', 'follow-ups.md');
});
afterAll(async () => {
  await t.close();
});
const send = (method: 'POST' | 'DELETE', url: string, payload: Record<string, unknown>) => t.app.inject({ method, url, headers: t.authedWrite, payload });
// Fixture row #6 is Vandelay Systems / Senior Python Engineer; #1 is Acme Robotics / Senior Backend Engineer.
const ACME = { expectCompany: 'Acme Robotics', expectRole: 'Senior Backend Engineer' };
const VANDELAY = { expectCompany: 'Vandelay Systems', expectRole: 'Senior Python Engineer' };
const LOG = { date: '2026-10-03', channel: 'Email', contact: '', notes: 'meant for Acme' };

describe('follow-up writes naming a row that now holds another application', () => {
  it('given row #6 is no longer Acme, when a follow-up for Acme is logged under #6, then it is refused as stale and nothing is written', async () => {
    const before = fs.readFileSync(file, 'utf8');
    const r = await send('POST', '/api/followups/log', { appNum: 6, ...LOG, ...ACME });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe('stale');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('given the role differs, when a follow-up is logged, then it is refused as stale', async () => {
    const r = await send('POST', '/api/followups/log', { appNum: 6, ...LOG, expectCompany: 'Vandelay Systems', expectRole: 'Staff Engineer' });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe('stale');
  });

  it('given the row still holds the application, when a follow-up is logged, then it is written', async () => {
    const r = await send('POST', '/api/followups/log', { appNum: 6, ...LOG, notes: 'right row', ...VANDELAY });
    expect(r.statusCode, r.body).toBe(200);
    expect(fs.readFileSync(file, 'utf8')).toContain('| 6 | 2026-10-03 | Vandelay Systems | Senior Python Engineer | Email |  | right row |');
  });

  it('given row #6 is no longer Acme, when Acme is pinned under #6, then it is refused as stale and no pin is written', async () => {
    const before = fs.readFileSync(file, 'utf8');
    const r = await send('POST', '/api/followups/override', { appNum: 6, date: '2026-10-21', ...ACME });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe('stale');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('given a row number no longer in the tracker, when it is pinned with an expected row, then it is refused as stale', async () => {
    const before = fs.readFileSync(file, 'utf8');
    const r = await send('POST', '/api/followups/override', { appNum: 99, date: '2026-10-21', ...ACME });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe('stale');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('given row #6 is no longer Acme, when Acme\'s pin is cleared under #6, then it is refused as stale and #6\'s pin stays', async () => {
    expect((await send('POST', '/api/followups/override', { appNum: 6, date: '2026-10-21', ...VANDELAY })).statusCode).toBe(200);
    const before = fs.readFileSync(file, 'utf8');
    const r = await send('DELETE', '/api/followups/override', { appNum: 6, ...ACME });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe('stale');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect((await send('DELETE', '/api/followups/override', { appNum: 6, ...VANDELAY })).statusCode).toBe(200);
  });
});

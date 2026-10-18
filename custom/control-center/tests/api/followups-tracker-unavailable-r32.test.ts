// Follow-up Log and Pin look the row up in the tracker. When the tracker cannot be read, the write is refused with the
// tracker's own problem, not as a stale row (which tells the page to reload, and reloading changes nothing) or as a
// missing row (R32-srv-core-L2-01).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';

let t: TestApp;
let tracker: string;
let followups: string;
beforeEach(async () => {
  t = await makeTestApp();
  tracker = path.join(t.cfg.dataRoot, 'data', 'applications.md');
  followups = path.join(t.cfg.dataRoot, 'data', 'follow-ups.md');
});
afterEach(async () => {
  await t.close();
});
const send = (method: 'POST' | 'DELETE', url: string, payload: Record<string, unknown>) => t.app.inject({ method, url, headers: t.authedWrite, payload });
const VANDELAY = { expectCompany: 'Vandelay Systems', expectRole: 'Senior Python Engineer' };
const LOG = { appNum: 6, date: '2026-10-03', channel: 'Email', contact: '', notes: 'n' };
const malform = () => fs.writeFileSync(tracker, '# Applications Tracker\n\n| # | Date | Company |\n|---|---|---|\n| not | a | row |\n');

describe('follow-up writes when the tracker cannot be read', () => {
  it('given a malformed tracker, when a follow-up is logged with an expected row, then the tracker problem is reported, not stale', async () => {
    malform();
    const before = fs.readFileSync(followups, 'utf8');
    const r = await send('POST', '/api/followups/log', { ...LOG, ...VANDELAY });
    expect(r.statusCode, r.body).toBe(503);
    expect(r.json().error).toMatch(/^tracker unavailable: .*no parseable rows/);
    expect(fs.readFileSync(followups, 'utf8')).toBe(before);
  });

  it('given a malformed tracker, when a follow-up is logged without an expected row, then the tracker problem is reported, not a missing row', async () => {
    malform();
    const r = await send('POST', '/api/followups/log', LOG);
    expect(r.statusCode, r.body).toBe(503);
    expect(r.json().error).toMatch(/^tracker unavailable: /);
  });

  it('given a malformed tracker, when a pin is set or cleared with an expected row, then the tracker problem is reported', async () => {
    malform();
    const set = await send('POST', '/api/followups/override', { appNum: 6, date: '2026-10-21', ...VANDELAY });
    expect(set.statusCode, set.body).toBe(503);
    expect(set.json().error).toMatch(/^tracker unavailable: /);
    const clear = await send('DELETE', '/api/followups/override', { appNum: 6, ...VANDELAY });
    expect(clear.statusCode, clear.body).toBe(503);
    expect(clear.json().error).toMatch(/^tracker unavailable: /);
  });

  it('given no tracker file, when a follow-up is logged with an expected row, then the missing tracker is named', async () => {
    fs.rmSync(tracker);
    const r = await send('POST', '/api/followups/log', { ...LOG, ...VANDELAY });
    expect(r.statusCode, r.body).toBe(404);
    expect(r.json().error).toMatch(/^tracker unavailable: no tracker at /);
  });
});

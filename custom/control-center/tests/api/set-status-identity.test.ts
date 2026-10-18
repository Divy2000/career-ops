import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';

// A delete reindexes the tracker, so the number a page loaded can name another application by the time it is clicked.
describe('tracker.setStatus identity guard (R30-feat-c-L2-01)', () => {
  let t: TestApp;
  const tracker = () => fs.readFileSync(path.join(t.cfg.dataRoot, 'data', 'applications.md'), 'utf8');
  const rowLine = (num: number) => tracker().split('\n').find((l) => l.startsWith(`| ${num} |`)) ?? '';
  const setStatus = (params: Record<string, unknown>) => t.app.inject({ method: 'POST', url: '/api/actions/tracker.setStatus', headers: t.authedWrite, payload: { params } });
  beforeAll(async () => {
    t = await makeTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('refuses when the row under that number is no longer the one the page showed', async () => {
    // The page loaded Umbrella Corp as #2; #2 is now Northwind Analytics.
    const r = await setStatus({ row: 2, state: 'Applied', expectCompany: 'Umbrella Corp', expectRole: 'Security Analyst', expectReport: null });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toMatch(/#2 now holds Northwind Analytics/);
    expect(rowLine(2)).toContain('| Evaluated |');
  });

  it('refuses when only the report differs', async () => {
    const r = await setStatus({ row: 2, state: 'Applied', expectCompany: 'Northwind Analytics', expectRole: 'ML Platform Engineer', expectReport: 9 });
    expect(r.statusCode, r.body).toBe(409);
    expect(rowLine(2)).toContain('| Evaluated |');
  });

  it('sets the status when the row still matches', async () => {
    const r = await setStatus({ row: 2, state: 'Applied', expectCompany: 'Northwind Analytics', expectRole: 'ML Platform Engineer', expectReport: 2 });
    expect(r.statusCode, r.body).toBe(200);
    expect(rowLine(2)).toContain('| Applied |');
  });

  it('matches a row without a report by a null expectReport', async () => {
    const r = await setStatus({ row: 5, state: 'Discarded', note: 'DISCARD: other', expectCompany: 'Umbrella Corp', expectRole: 'Security Analyst', expectReport: null });
    expect(r.statusCode, r.body).toBe(200);
    expect(rowLine(5)).toContain('| Discarded |');
  });

  it('refuses when the number no longer names any row', async () => {
    const r = await setStatus({ row: 99, state: 'Applied', expectCompany: 'Acme Robotics', expectRole: 'Senior Backend Engineer', expectReport: 1 });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toMatch(/#99/);
  });
});

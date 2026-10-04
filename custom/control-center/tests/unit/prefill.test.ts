import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { PREFILL_ATS_HOSTS, prefillUrlProblem } from '../../shared/prefill.js';

describe('prefillUrlProblem', () => {
  it('accepts Greenhouse, Ashby and Lever apply links', () => {
    expect(prefillUrlProblem('https://boards.greenhouse.io/acme/jobs/123')).toBeNull();
    expect(prefillUrlProblem('https://jobs.ashbyhq.com/acme/abc-123')).toBeNull();
    expect(prefillUrlProblem('https://jobs.eu.lever.co/acme/abc-123')).toBeNull();
  });

  it('names the host of a job-board listing and says where the real apply link is', () => {
    const problem = prefillUrlProblem('https://www.builtinaustin.com/job/associate-software-engineer/10931484');
    expect(problem).toContain('www.builtinaustin.com');
    expect(problem).toMatch(/Greenhouse, Ashby and Lever apply links only/);
    expect(problem).toMatch(/Apply button/);
  });

  it('asks for https and for a whole URL', () => {
    expect(prefillUrlProblem('http://boards.greenhouse.io/acme/jobs/123')).toMatch(/https/);
    expect(prefillUrlProblem('boards.greenhouse.io/acme')).toMatch(/full apply link/);
  });

  it('mirrors the ALLOWED_HOSTS of the installed prepare-application.mjs', () => {
    const source = fs.readFileSync(path.join(DEFAULT_CODE_ROOT, 'prepare-application.mjs'), 'utf8');
    const block = source.match(/const ALLOWED_HOSTS = new Set\(\[([\s\S]*?)\]\)/);
    expect(block, 'ALLOWED_HOSTS literal in prepare-application.mjs').not.toBeNull();
    const upstream = [...block![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...PREFILL_ATS_HOSTS].sort()).toEqual(upstream.sort());
  });
});

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { copyFixtureRoot } from '../helpers/app.js';
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

  it('names the shape a Greenhouse link needs when the job number is missing', () => {
    expect(prefillUrlProblem('https://boards.greenhouse.io/acme')).toBe('This Greenhouse link does not point at one job. Use the posting link shaped like boards.greenhouse.io/<company>/jobs/<number>.');
  });

  it('names the shape an Ashby or Lever link needs when the posting id is missing', () => {
    expect(prefillUrlProblem('https://jobs.ashbyhq.com/acme')).toBe('This Ashby link does not point at one job. Use the posting link shaped like jobs.ashbyhq.com/<company>/<posting id>.');
    expect(prefillUrlProblem('https://jobs.lever.co/acme')).toBe('This Lever link does not point at one job. Use the posting link shaped like jobs.lever.co/<company>/<posting id>.');
  });

  // Each link goes through the real script: whatever it accepts must pass here and whatever it rejects must not.
  const root = copyFixtureRoot();
  it.each([
    'https://boards.greenhouse.io/acme/jobs/123',
    'https://greenhouse.io/acme/jobs/123?gh_src=abc',
    'https://boards.greenhouse.io/acme',
    'https://boards.greenhouse.io/acme/jobs/abc',
    'https://boards.greenhouse.io/ac%20me/jobs/1',
    'https://boards.greenhouse.io/embed/job_app?token=123',
    'https://jobs.ashbyhq.com/acme/abc-123',
    'https://jobs.ashbyhq.com/acme',
    'https://ashbyhq.com/acme/abc-123/application',
    'https://jobs.lever.co/acme/abc-123',
    'https://jobs.eu.lever.co/acme/abc-123/apply',
    'https://jobs.lever.co/acme',
    'https://jobs.lever.co/ac!me/abc',
    'http://jobs.lever.co/acme/abc-123',
    'https://www.builtinaustin.com/job/associate-software-engineer/10931484',
  ])('agrees with prepare-application.mjs on %s', (url) => {
    const r = spawnSync(process.execPath, [path.join(DEFAULT_CODE_ROOT, 'prepare-application.mjs'), '--url', url, '--pdf', 'output/acme-robotics-cv.pdf'], {
      cwd: DEFAULT_CODE_ROOT,
      env: { ...process.env, CAREER_OPS_ROOT: root, NO_COLOR: '1' },
      encoding: 'utf8',
    });
    expect(prefillUrlProblem(url) === null, `script exit ${r.status}: ${r.stderr}`).toBe(r.status === 0);
  });

  it('mirrors the ALLOWED_HOSTS of the installed prepare-application.mjs', () => {
    const source = fs.readFileSync(path.join(DEFAULT_CODE_ROOT, 'prepare-application.mjs'), 'utf8');
    const block = source.match(/const ALLOWED_HOSTS = new Set\(\[([\s\S]*?)\]\)/);
    expect(block, 'ALLOWED_HOSTS literal in prepare-application.mjs').not.toBeNull();
    const upstream = [...block![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...PREFILL_ATS_HOSTS].sort()).toEqual(upstream.sort());
  });
});

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { copyFixtureRoot, FAKE_TOKEN, makeTestApp, type TestApp } from '../helpers/app.js';
import { runsEnded } from '../helpers/runs.js';
import { tempDir } from '../helpers/tmp.js';
import { BusyError, evaluationClass, postingKey } from '../../server/claude/manager.js';
import { postingClaimFile } from '../../server/claude/process-claim.js';

// R32-claude-H-01: two server processes on one data root (blue/green) both passed liveEvaluationFor() before either
// recorded its session, so a start of one posting on each began two paid evaluations of it. The in-process fan-out set
// could not see the other process.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const URL = 'https://jobs.example.com/synthetic/r32-claim';
// A slow token read holds each start between its checks and its turn's spawn, where the two used to overlap.
const slowToken = { readToken: async () => (await wait(300), FAKE_TOKEN) };

async function pair(): Promise<{ a: TestApp; b: TestApp; dataRoot: string }> {
  const dataRoot = copyFixtureRoot();
  const guardRoot = tempDir('cc-r32-posting-guard-');
  return { a: await makeTestApp({ dataRoot, guardRoot }, slowToken), b: await makeTestApp({ dataRoot, guardRoot }, slowToken), dataRoot };
}

async function idle(app: TestApp): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (app.sessions.list().some((m) => m.status === 'running' || m.status === 'queued' || app.sessions.isActive(m.id))) {
    if (Date.now() > deadline) throw new Error('sessions still running');
    await wait(50);
  }
}

const post = (app: TestApp) => app.app.inject({ method: 'POST', url: '/api/sessions', headers: app.authedWrite, payload: { mode: 'oferta', target: { type: 'url', value: URL }, prompt: 'Evaluate this posting' } });

describe('one posting started through two server processes at once (R32-claude-H-01)', () => {
  it('given two processes that both found the posting free, when both start its evaluation together, then one starts and the other is refused as busy', async () => {
    const { a, b, dataRoot } = await pair();
    try {
      const target = { type: 'url' as const, value: URL };
      // Each process's route checked first and found nothing: the interleaving two separate processes can hit.
      expect(a.sessions.liveEvaluationFor('oferta', target)).toBeNull();
      expect(b.sessions.liveEvaluationFor('oferta', target)).toBeNull();
      const started = await Promise.allSettled([a, b].map((app) => app.sessions.start({ mode: 'oferta', target, prompt: 'Evaluate this posting', reportNum: null })));
      expect(started.map((s) => s.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect((started.find((s) => s.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(BusyError);
      await idle(a);
      await idle(b);
      expect(a.sessions.list().filter((m) => m.target.value === URL)).toHaveLength(1);
    } finally {
      await a.close();
      await b.close();
      await runsEnded(dataRoot);
    }
  });

  it('given a batch evaluate starting a posting in one process, when the other starts the same posting, then only one session evaluates it', async () => {
    const { a, b, dataRoot } = await pair();
    try {
      const fan = a.app.inject({ method: 'POST', url: '/api/sessions/fanout', headers: a.authedWrite, payload: { mode: 'oferta', urls: [URL] } });
      const single = post(b);
      await Promise.all([fan, single]);
      await idle(a);
      await idle(b);
      expect(a.sessions.list().filter((m) => m.target.value === URL && m.turns.length > 0)).toHaveLength(1);
    } finally {
      await a.close();
      await b.close();
      await runsEnded(dataRoot);
    }
  });

  it('given a posting claim left by a process that is gone, when a start comes, then it takes the claim over and starts', async () => {
    const { a, b, dataRoot } = await pair();
    try {
      const dead = spawnSync(process.execPath, ['-e', '']).pid!;
      const file = postingClaimFile(a.cfg.guardRoot, `${evaluationClass('oferta')}\0${postingKey('oferta', { type: 'url', value: URL })}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ pid: dead, at: Date.now(), nonce: 'gone' }));
      expect((await post(a)).statusCode).toBe(202);
      await idle(a);
      // Its claim went once the session was recorded and running: the other process is refused by the session alone.
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      await a.close();
      await b.close();
      await runsEnded(dataRoot);
    }
  });

  it('given a posting claim a live peer holds, when a start comes, then it is refused with 409 and no session is recorded', async () => {
    const { a, b, dataRoot } = await pair();
    try {
      const file = postingClaimFile(a.cfg.guardRoot, `${evaluationClass('oferta')}\0${postingKey('oferta', { type: 'url', value: URL })}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), nonce: 'peer' }));
      expect((await post(a)).statusCode).toBe(409);
      const fan = await a.app.inject({ method: 'POST', url: '/api/sessions/fanout', headers: a.authedWrite, payload: { mode: 'oferta', urls: [URL] } });
      expect(fan.json().sessions[0].error).toMatch(/already starting/);
      expect(a.sessions.list()).toHaveLength(0);
    } finally {
      await a.close();
      await b.close();
      await runsEnded(dataRoot);
    }
  });
});

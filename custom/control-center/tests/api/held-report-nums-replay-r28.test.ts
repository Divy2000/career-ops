import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { copyFixtureRoot, makeTestApp, PACKAGE_ROOT } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

// R28-cl2-rev-01 review: at a restart the manager replays the output a previous server already handled. Its holds were
// recorded then; recording them again would take whatever sentinel sits under the number now, maybe another evaluation's.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !pred(); await wait(50)) if (Date.now() > deadline) throw new Error('timed out');
}

describe('replaying a turn at a restart (R28-cl2-rev-01)', () => {
  it('given a reservation the previous server already handled and another evaluation now holding that number, when the turn is replayed, then no hold on it is recorded', async () => {
    const app = await makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
    try {
      const lines = [
        { type: 'system', subtype: 'init', model: 'fake-model', tools: ['Bash'], session_id: 'c1' },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_r', name: 'Bash', input: { command: 'node reserve-report-num.mjs' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r', is_error: false, content: '061' }] } },
      ];
      const script = `for (const l of ${JSON.stringify(lines.map((l) => JSON.stringify(l)))}) console.log(l)`;
      const meta = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null });
      const run = app.runner.start({ actionId: 'session.oferta', label: 'Evaluate: turn 1', cost: 'tokens', resources: [], claude: false, params: { sessionId: meta.id, turn: 1 }, cmd: { bin: process.execPath, args: ['-e', script], cwd: PACKAGE_ROOT } });
      app.sessions.store.beginTurn(meta.id, { runId: run.id, userText: 'Evaluate' });
      await until(() => app.runner.store.read(run.id)?.status !== 'running' && app.runner.store.readRaw(run.id).lines.length >= lines.length);
      // The previous server handled every line (and released 061 since); another evaluation now holds 061.
      const raw = app.runner.store.readRaw(run.id);
      const guard = app.sessions.store.guardDirOf(meta.id);
      const turnDir = path.join(guard, 'turns', '1');
      fs.mkdirSync(turnDir, { recursive: true });
      fs.writeFileSync(path.join(turnDir, 'progress.json'), JSON.stringify({ rawSeq: raw.lines.at(-1)!.seq, rawOffset: raw.offset }));
      fs.writeFileSync(path.join(app.cfg.dataRoot, 'reports', '061-RESERVED.md'), JSON.stringify({ pid: process.pid, token: 'another-evaluation', created_at: new Date().toISOString() }));
      app.sessions.close();
      app.sessions.reconcile();
      await until(() => app.sessions.read(meta.id)!.turns[0]!.endedAt !== null);
      const log = path.join(guard, 'held-report-nums.log');
      expect(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').not.toMatch(/\+61=/);
    } finally {
      await app.close();
    }
  });
});

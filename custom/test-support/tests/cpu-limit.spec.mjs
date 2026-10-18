import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../tmp.mjs';
import { spawnCpuLimited } from '../cpu-limit.mjs';

const script = (body) => {
  const file = path.join(tempDir('cpu-limit-'), 'script.sh');
  fs.writeFileSync(file, body);
  return file;
};

test('Given a CPU budget, the command and every process it starts run under that CPU-time limit', () => {
  const r = spawnCpuLimited('bash', [script('ulimit -t\nbash -c "ulimit -t"\n')], { cpuSeconds: 7 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '7\n7\n');
});

test('Given a command that sleeps longer than its CPU budget, it is not killed, because waiting uses no CPU', () => {
  const r = spawnCpuLimited('bash', [script('sleep 2\necho done\n')], { cpuSeconds: 1 });
  assert.equal(r.signal, null, `killed by ${r.signal}`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'done\n');
});

test('Given a command that spins in a loop, it is killed once it uses its CPU budget', () => {
  const r = spawnCpuLimited('bash', [script('while :; do :; done\n')], { cpuSeconds: 1 });
  assert.equal(r.status, null);
  assert.ok(r.signal, 'the spinning command was not killed');
});

test('Given a command blocked on a child that never ends, the wall-clock backstop kills it', () => {
  // exec, so the timeout's SIGTERM reaches the sleeping process itself and leaves nothing running.
  const r = spawnCpuLimited('bash', [script('exec sleep 60\n')], { cpuSeconds: 1, hangMs: 1000 });
  assert.equal(r.status, null);
  assert.ok(r.signal, 'the blocked command was not killed');
});

test('Given stdin input and spawn options, they reach the command unchanged', () => {
  const dir = tempDir('cpu-limit-cwd-');
  const r = spawnCpuLimited('bash', [], { input: 'pwd -P\necho "$PROBE"\n', cwd: dir, env: { PATH: '/usr/bin:/bin', PROBE: 'seen' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${fs.realpathSync(dir)}\nseen\n`);
});

test('Given no CPU budget, the command runs under the default 30 s CPU-time limit (R34-mut-01, R34-mut-02)', () => {
  const r = spawnCpuLimited('bash', [script('ulimit -t\n')]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '30\n');
});

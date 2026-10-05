import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const RUN_DAILY = path.join(HERE, '..', 'run-daily.sh');

/** The node -e program run-daily.sh fills the policy prompt with, run as the script runs it (cwd = the checkout). */
function fillPrompt(env) {
  const script = readFileSync(RUN_DAILY, 'utf8');
  const src = script.match(/prompt="\$\(WATCH_JSON=.*? node -e '([\s\S]*?)'\)"/)?.[1];
  assert.ok(src, 'the prompt-filling node -e program was not found in run-daily.sh');
  const r = spawnSync(process.execPath, ['-e', src], { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('the policy prompt carries the watch JSON, the date and the data dir verbatim, even when they hold $ replacement patterns', () => {
  const watch = '{"items":[{"title":"Fee rises to $& and $$5 ($` then $\')"}]}';
  const imm = '/data/$&root/data/immigration';
  const out = fillPrompt({ WATCH_JSON: watch, TODAY: '2026-10-04', IMM: imm });
  assert.ok(out.includes(watch), out.slice(0, 2000));
  assert.ok(out.includes(`\`${imm}/policy-changes.tsv\``));
  assert.ok(out.includes('Today is 2026-10-04.'));
  assert.equal(out.includes('{{'), false, 'every placeholder is filled');
});

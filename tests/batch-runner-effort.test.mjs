// tests/batch-runner-effort.test.mjs: batch workers launched through claude
// run at an explicit `--effort medium`, never at whatever effort the user's
// settings happen to default to. `--effort` is a Claude Code flag, so the other
// CLIs the runner dispatches to must not be handed it.
//
// Runs the REAL batch-runner.sh against one offer with fake agent CLIs first on
// PATH that record their argv, so the assertion is on the command line the
// runner actually spawns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { getBash, rmSync } from './helpers.mjs';

const SRC = readFileSync(new URL('../batch/batch-runner.sh', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function runOneOffer(cli) {
  const dir = mkdtempSync(join(tmpdir(), 'batch-effort-'));
  const batchDir = join(dir, 'batch');
  const binDir = join(dir, 'bin');
  const argvFile = join(dir, 'argv.txt');
  for (const d of [batchDir, binDir, join(dir, 'reports'), join(dir, 'data')]) mkdirSync(d, { recursive: true });

  writeFileSync(join(batchDir, 'batch-runner.sh'), SRC);
  chmodSync(join(batchDir, 'batch-runner.sh'), 0o755);
  writeFileSync(join(batchDir, 'batch-prompt.md'), 'URL={{URL}}\nJD={{JD_FILE}}\nREPORT={{REPORT_NUM}}\n');
  writeFileSync(join(batchDir, 'batch-input.tsv'), 'id\turl\tsource\tnotes\n1\thttps://example.com/one\tfixture\t-\n');
  for (const script of ['merge-tracker', 'reconcile-pipeline', 'verify-pipeline']) {
    writeFileSync(join(dir, `${script}.mjs`), '// No external integrations in this fixture.\n');
  }
  // The fake CLI records one argument per line and exits non-zero: only the
  // launch command matters here, not a fabricated evaluation.
  writeFileSync(join(binDir, cli), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvFile}"\nexit 1\n`);
  // JD prefetch fails fast instead of touching the network.
  writeFileSync(join(binDir, 'curl'), '#!/usr/bin/env bash\nexit 1\n');
  chmodSync(join(binDir, cli), 0o755);
  chmodSync(join(binDir, 'curl'), 0o755);

  try {
    try {
      execFileSync(getBash(), [join(batchDir, 'batch-runner.sh'), '--cli', cli, '--parallel', '1', '--max-retries', '0', '--rate-limit-sleep', '0'], {
        cwd: dir,
        env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH}` },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
      });
    } catch {
      // A failed worker can make the runner exit non-zero; the recorded argv is what this test reads.
    }
    assert.ok(existsSync(argvFile), `the runner never launched ${cli}`);
    return readFileSync(argvFile, 'utf8').split('\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a claude worker is launched with --effort medium', { skip: process.platform === 'win32' }, () => {
  const argv = runOneOffer('claude');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'medium', `claude argv: ${argv.join(' ')}`);
});

test('a non-claude worker is never handed --effort', { skip: process.platform === 'win32' }, () => {
  const argv = runOneOffer('opencode');
  assert.equal(argv[0], 'run', `opencode argv: ${argv.join(' ')}`);
  assert.ok(!argv.includes('--effort'), `opencode argv: ${argv.join(' ')}`);
});

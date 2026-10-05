import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYNC = path.join(HERE, '..', 'sync.sh');

function stub(dir, name, body) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`);
  chmodSync(path.join(dir, name), 0o755);
}

/** The lines of sync.sh from the one starting with `first` through the next one matching `last`. */
function block(first, last) {
  const lines = readFileSync(SYNC, 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith(first));
  assert.ok(from > -1, `no line starting with ${first}`);
  const to = lines.findIndex((l, i) => i >= from && last.test(l));
  return lines.slice(from, to + 1).join('\n');
}

test('the headless sync Claude gets the OAuth token but runs with subprocess env scrubbing, so Bash children (tests, npm scripts) never see it', () => {
  const dir = tempDir('sync-claude-');
  const bin = path.join(dir, 'bin');
  const seen = path.join(dir, 'env.txt');
  stub(bin, 'claude', `env > "${seen}"`);
  const script = `TOKEN=tok-123 MODEL=m STATE_DIR="${dir}" PROMPT=p\n${block('CLAUDE_CODE_OAUTH_TOKEN=', /--output-format text/)}`;
  const r = spawnSync('bash', ['-c', script], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const env = readFileSync(seen, 'utf8');
  assert.match(env, /^CLAUDE_CODE_OAUTH_TOKEN=tok-123$/m);
  assert.match(env, /^CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1$/m);
  assert.match(env, /^ANTHROPIC_API_KEY=$/m);
});

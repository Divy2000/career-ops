import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { gitTestEnv } from '../git-env.mjs';

test('the git env for specs drops every repository and config override a shell can inject, and pins a test identity', () => {
  const injected = Object.fromEntries(execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).trim().split('\n').map((k) => [k, '/injected']));
  const env = gitTestEnv({ PATH: '/bin', HOME: '/home/me', ...injected, GIT_CONFIG_PARAMETERS: "'commit.gpgsign'='true'", GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Injected' });
  for (const k of Object.keys(injected)) if (k !== 'GIT_CONFIG_COUNT') assert.equal(env[k], undefined, k);
  assert.equal(env.GIT_CONFIG_COUNT, '0', 'GIT_CONFIG_KEY_n / VALUE_n are ignored');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.GIT_CONFIG_SYSTEM, '/dev/null');
  assert.equal(env.GIT_AUTHOR_NAME, 'Test');
  assert.equal(env.GIT_COMMITTER_EMAIL, 'test@example.invalid');
  assert.equal(env.PATH, '/bin');
});

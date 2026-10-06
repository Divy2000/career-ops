// The environment for git in the custom specs: upstream's hermeticGitEnv (no global or system config, no
// GIT_CONFIG_PARAMETERS or GIT_CONFIG, GIT_CONFIG_COUNT pinned to 0), minus every repository override git reads from
// the environment (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and the rest of `git rev-parse --local-env-vars`), with a
// fixed test identity. A shell, or a parent git hook, that exports any of them would otherwise send a spec's git
// commands at another repository or change how they commit.
import { execFileSync } from 'node:child_process';
import { hermeticGitEnv } from '../../tests/helpers.mjs';

const LOCAL_VARS = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);

export function gitTestEnv(base = process.env) {
  const env = hermeticGitEnv('/dev/null', base);
  for (const k of LOCAL_VARS) if (k !== 'GIT_CONFIG_COUNT') delete env[k];
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
}

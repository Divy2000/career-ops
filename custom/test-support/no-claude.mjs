// A mutant can turn a test's fake Claude path back into plain `claude`, which would run the real CLI (live API
// calls, an agent acting on this machine). Mutation runs put a `claude` that always fails first on PATH instead.
import fs from 'node:fs';
import path from 'node:path';

/** Writes the failing `claude` into dir and returns env with dir first on PATH. */
export function blockClaude(dir, env = process.env) {
  fs.mkdirSync(dir, { recursive: true });
  const stub = path.join(dir, 'claude');
  fs.writeFileSync(stub, '#!/bin/sh\necho "claude is blocked during mutation testing" >&2\nexit 127\n', { mode: 0o755 });
  return { ...env, PATH: env.PATH ? `${dir}${path.delimiter}${env.PATH}` : dir };
}

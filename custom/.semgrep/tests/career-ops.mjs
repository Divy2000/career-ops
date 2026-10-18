// Rule tests for ../career-ops.yml on plain JavaScript (.mjs), as the server's .mjs helpers and the custom/ scripts are.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

// ruleid: child-process-env-not-filtered
spawnSync('security', ['find-generic-password', '-w']);
// ruleid: child-process-env-raw-process-env
spawn('npx', ['x'], { stdio: 'inherit', env: { ...process.env, A: '1' } });
// ok: child-process-env-not-filtered, child-process-env-raw-process-env
spawn('npx', ['x'], { stdio: 'inherit', env: playwrightMcpEnv(process.env) });

export function today() {
  // ruleid: utc-iso-date-as-local-day
  return new Date().toISOString().split('T')[0];
}

export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  // ruleid: mixed-local-and-utc-date-math
  return d.getMonth();
}

export async function save(PIPELINE, text) {
  // ruleid: shared-state-write-not-atomic
  await fs.promises.writeFile(PIPELINE, text);
  const tmp = `${PIPELINE}.tmp`;
  // ok: shared-state-write-not-atomic
  await fs.promises.writeFile(tmp, text);
  await fs.promises.rename(tmp, PIPELINE);
}

function playwrightMcpEnv(env) {
  return env;
}

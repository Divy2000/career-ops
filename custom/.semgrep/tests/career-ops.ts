import { spawn as launch } from 'node:child_process';
// Rule tests for ../career-ops.yml: `ruleid:` marks the next line as a required finding, `ok:` as a required non-finding.
import { spawn, execFile, execFileSync } from 'node:child_process';
import * as cp from 'child_process';
import fs from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { childEnv } from '../server/system/child-env.js';

declare const probeEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
declare const manager: { fork(id: string): void };
declare const env: NodeJS.ProcessEnv;
declare const dataRoot: string;
declare const TRACKER: string;
declare const text: string;
declare const localDay: (d: Date) => string;

// ---- child-env-not-filtered
// ruleid: child-process-env-not-filtered
spawn('node', ['x.mjs'], { stdio: 'inherit' });
// ruleid: child-process-env-not-filtered
execFile('open', ['https://example.com'], { shell: false }, () => undefined);
// ruleid: child-process-env-not-filtered
execFile('open', ['https://example.com'], () => undefined);
// ruleid: child-process-env-not-filtered
cp.spawnSync('git', ['status']);
// ok: child-process-env-not-filtered
spawn('node', ['x.mjs'], { env: childEnv({ EXTRA: '1' }) });
// ok: child-process-env-not-filtered
execFile('claude', ['--version'], { shell: false, env: { ...probeEnv(process.env), DISABLE_AUTOUPDATER: '1' } }, () => undefined);
// ok: child-process-env-not-filtered
execFileSync('/bin/ps', ['-o', 'lstart='], { env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' } });
// ok: child-process-env-not-filtered
spawn('node', [], { cwd: '/', env, shell: false });
// ok: child-process-env-not-filtered
manager.fork('s1');

async function dynamicImport() {
  const { spawn: dynSpawn } = await import('node:child_process');
  // ruleid: child-process-env-not-filtered
  dynSpawn('tool', ['arg']);
  const cp2 = await import('child_process');
  // ruleid: child-process-env-not-filtered
  cp2.execFile('tool', ['arg'], () => undefined);
  // ok: child-process-env-not-filtered
  dynSpawn('tool', ['arg'], { env: childEnv() });
}
function requireForm() {
  const { execFileSync: run } = require('node:child_process');
  // ruleid: child-process-env-not-filtered
  run('tool', ['arg']);
}
// ruleid: child-process-env-not-filtered
launch('tool', ['arg']);
// ok: child-process-env-not-filtered
launch('tool', ['arg'], { env: childEnv() });

// ---- child-process-env-raw-process-env
// ruleid: child-process-env-raw-process-env
spawn('node', ['x.mjs'], { env: process.env });
// ruleid: child-process-env-raw-process-env
cp.spawnSync('claude', ['--version'], { encoding: 'utf8', env: { ...process.env, DISABLE_AUTOUPDATER: '1' } });
// ruleid: child-process-env-raw-process-env
spawn('node', ['x.mjs'], { env: undefined });
function aliasRaw() {
  const env = process.env;
  // ruleid: child-process-env-raw-process-env
  spawn('node', ['x.mjs'], { env });
}
function aliasSpread() {
  const env2 = { ...process.env, EXTRA: '1' };
  // ruleid: child-process-env-raw-process-env
  execFile('node', ['x.mjs'], { env: env2 }, () => undefined);
}
function aliasFiltered() {
  const env3 = childEnv({ EXTRA: '1' });
  // ok: child-process-env-raw-process-env
  spawn('node', ['x.mjs'], { env: env3 });
}
// ok: child-process-env-raw-process-env
spawn('node', ['x.mjs'], { env: childEnv() });
// ok: child-process-env-raw-process-env
execFile('claude', ['--version'], { env: { ...probeEnv(process.env), DISABLE_AUTOUPDATER: '1' } }, () => undefined);

// ---- utc-iso-date-as-local-day
export function todayWrong(): string {
  // ruleid: utc-iso-date-as-local-day
  return new Date().toISOString().slice(0, 10);
}
export function todayWrongVar(): string {
  const now = new Date();
  // ruleid: utc-iso-date-as-local-day
  return now.toISOString().slice(0, 10);
}
export function validDay(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  // ok: utc-iso-date-as-local-day
  return d.toISOString().slice(0, 10) === s;
}
export function stamp(): string {
  // ok: utc-iso-date-as-local-day
  return new Date().toISOString();
}

// ---- mixed-local-and-utc-date-math
export function plusDaysWrong(from: Date, days: number): string {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  // ruleid: mixed-local-and-utc-date-math
  return d.toISOString().slice(0, 10);
}
export function startOfMonthWrong(now: Date): string {
  // ruleid: mixed-local-and-utc-date-math
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}
export function isoWeekWrong(d: Date): number {
  d.setUTCDate(d.getUTCDate() + 4);
  // ruleid: mixed-local-and-utc-date-math
  const day = d.getDay();
  return day;
}
export function plusDaysUtc(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  // ok: mixed-local-and-utc-date-math
  return d.toISOString().slice(0, 10);
}
export function plusDaysLocal(from: Date, days: number): string {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  // ok: mixed-local-and-utc-date-math
  return localDay(d);
}

// ---- shared-state-write-not-atomic
export function writes(): void {
  // ruleid: shared-state-write-not-atomic
  fs.writeFileSync(`${dataRoot}/data/applications.md`, text);
  // ruleid: shared-state-write-not-atomic
  fs.writeFileSync(TRACKER, text);
  // ruleid: shared-state-write-not-atomic
  void writeFile(`${dataRoot}/data/scan-history.tsv`, text);
  // ok: shared-state-write-not-atomic
  fs.writeFileSync(`${TRACKER}.tmp-${process.pid}`, text);
  // ok: shared-state-write-not-atomic
  fs.writeFileSync(`${dataRoot}/data/pipeline.md`, '', { flag: 'wx' });
  // ok: shared-state-write-not-atomic
  fs.writeFileSync(`${dataRoot}/runs/r1/exit.json`, text);
}

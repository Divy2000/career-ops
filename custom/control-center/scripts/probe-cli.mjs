// What both Claude CLI probes (claude-probe.mjs, claude-probe-reads.mjs) share with the app: which binary to run and
// how to read the Keychain token. One copy, so the probes cannot drift from each other or from supervisor/preflight.ts
// (tests/unit/claude-probe-invariants.test.ts compares resolveClaudeBin with the preflight's).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLAUDE_FALLBACKS = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'];

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The claude binary, resolved as supervisor/preflight.ts resolveClaudeBin does so the probe tests the one the app runs:
 * an absolute path as given, a relative one with a slash joined textually to the folder npm was started in (INIT_CWD,
 * else the cwd), a bare name looked up on PATH, then ~/.local/bin, then (for `claude` only) Homebrew and /usr/local.
 * A bare name found nowhere stays as it is, so the spawn reports ENOENT.
 */
export function resolveClaudeBin(bin, { env = process.env, home = os.homedir() } = {}) {
  if (path.isAbsolute(bin)) return bin;
  if (bin.includes('/')) {
    const from = env.INIT_CWD;
    const base = from && path.isAbsolute(from) ? from : process.cwd();
    return [base.replace(/\/+$/, ''), ...bin.split('/').filter((seg) => seg !== '.' && seg !== '')].join('/');
  }
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const fallbacks = bin === 'claude' ? CLAUDE_FALLBACKS : [];
  return [...dirs.map((d) => path.join(d, bin)), path.join(home, '.local', 'bin', bin), ...fallbacks].find((c) => path.isAbsolute(c) && isExecutable(c)) ?? bin;
}

/** CC_CLAUDE_BIN as the app reads it: empty or blank means unset. */
export const claudeBinFromEnv = (env = process.env) => resolveClaudeBin(env.CC_CLAUDE_BIN?.trim() || 'claude', { env });

const KEYCHAIN_ITEM = 'career-ops-claude-token';
export const KEYCHAIN_TIMEOUT_MS = 8000;

/**
 * Classifies a `security find-generic-password -w` result (spawnSync's shape) as the preflight does: absent only on
 * exit 44 (errSecItemNotFound) or a blank value on exit 0; any spawn error, timeout, signal or other exit means the
 * item could not be read, which must not send the user to recreate a token that is fine.
 * @param {{ status: number | null, signal?: string | null, stdout?: string, stderr?: string, error?: { code?: string, message: string } }} r
 * @param {number} [timeoutMs]
 * @returns {{ kind: 'token', token: string, problem?: undefined } | { kind: 'absent' | 'unreadable', problem: string, token?: undefined }}
 */
export function keychainOutcome(r, timeoutMs = KEYCHAIN_TIMEOUT_MS) {
  const unreadable = (why) => ({ kind: 'unreadable', problem: `Could not read Keychain item ${KEYCHAIN_ITEM}: ${why}. The login keychain is probably locked or cannot prompt (for example over SSH or before login). Unlock it with: security unlock-keychain, then retry.` });
  if (r.error?.code === 'ETIMEDOUT') return unreadable(`security timed out after ${timeoutMs / 1000}s`);
  if (r.error?.code === 'ENOENT') return { kind: 'unreadable', problem: `Could not read Keychain item ${KEYCHAIN_ITEM}: the security command was not found on PATH (it ships with macOS in /usr/bin).` };
  if (r.error) return unreadable(`security could not be run (${r.error.message})`);
  const token = String(r.stdout ?? '').trim();
  if (r.status === 44 || (r.status === 0 && !token)) return { kind: 'absent', problem: `Keychain item ${KEYCHAIN_ITEM} not found` };
  if (r.status !== 0) {
    const tail = String(r.stderr ?? '').trim().slice(-200);
    return unreadable(`security failed (${r.status === null ? `signal ${r.signal}` : `exit ${r.status}`}${tail ? `: ${tail}` : ''})`);
  }
  return { kind: 'token', token };
}

/**
 * The OAuth token, read bounded, because a locked keychain waits at an unlock prompt nobody may answer (over SSH,
 * before login). Exits 1 with the reason before the caller has acquired anything; never prints the token.
 */
export function readKeychainToken() {
  const r = spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_ITEM, '-w'], { encoding: 'utf8', timeout: KEYCHAIN_TIMEOUT_MS, killSignal: 'SIGKILL' });
  const out = keychainOutcome(r, KEYCHAIN_TIMEOUT_MS);
  if (out.kind !== 'token') {
    console.error(out.problem);
    process.exit(1);
  }
  return out.token;
}

/**
 * The parent environment a probe's CLI calls inherit, before server/system/child-env.ts childEnv: every CLAUDE* nested-
 * session variable, ANTHROPIC* credential and CC_* control variable dropped, so the Keychain token is the only Claude or
 * Anthropic credential a call gets. Other variables the shell exports pass, as they do to the app's sessions.
 */
export const probeInherited = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => !/^(CC_|CLAUDE|ANTHROPIC)/.test(k)));

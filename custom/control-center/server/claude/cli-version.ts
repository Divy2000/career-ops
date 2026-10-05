// Sessions run only on a Claude Code version whose read confinement was probed
// (scripts/claude-probe-reads.mjs records it in contract.json): a different CLI
// can change permission, hook or settings semantics while every fake-CLI test
// still passes. Checked at preflight and before every turn; the per-turn check
// re-runs `--version` only when the binary on disk changed.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { CONTRACT } from '../core/adapter.js';
import { parseClaudeVersion } from './confinement.mjs';

// Shared with the daily job, which gates its own Claude calls the same way.
export { parseClaudeVersion };

/** What tests/fakes/claude.mjs reports; accepted only under NODE_ENV=test. */
export const FAKE_CLAUDE_VERSION = '0.0.0-fake';
const VERSION_TIMEOUT_MS = 30_000;

export function approvedClaudeVersions(nodeEnv: string): string[] {
  const listed: string[] = [...CONTRACT.claude.approvedVersions];
  return nodeEnv === 'test' ? [...listed, FAKE_CLAUDE_VERSION] : listed;
}

export function unapprovedMessage(found: string, approved: string[]): string {
  const list = approved.length ? approved.join(', ') : 'none yet';
  const install = approved.find((v) => v !== FAKE_CLAUDE_VERSION);
  return `Claude Code ${found} is not approved for Control Center sessions (approved: ${list}); run \`npm run probe:reads\` and add it${install ? `, or \`claude install ${install}\`` : ''}`;
}

/** Preflight and the setup status: an unapproved CLI refuses sessions (per turn), never the app itself. */
export function unapprovedWarning(found: string, approved: string[]): string {
  return `${unapprovedMessage(found, approved)}. Sessions are refused until then; the rest of the app works.`;
}

export type VersionRunner = (bin: string) => Promise<{ code: number; stdout: string; stderr: string }>;

const runVersion: VersionRunner = (bin) =>
  new Promise((resolve) => {
    execFile(bin, ['--version'], { shell: false, timeout: VERSION_TIMEOUT_MS, env: { ...process.env, DISABLE_AUTOUPDATER: '1' } }, (err, stdout, stderr) => {
      // err.code is the exit status for a process that ran, or a string such as ENOENT for one that never started.
      const raw = (err as { code?: unknown } | null)?.code;
      resolve({ code: err ? (typeof raw === 'number' ? raw : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });

/** Version per binary file, keyed by its real path and stat, so a replaced or updated binary is asked again. */
const cache = new Map<string, string>();

function statKey(bin: string): string | null {
  try {
    const real = fs.realpathSync(bin);
    const st = fs.statSync(real);
    return `${real}\0${st.dev}\0${st.ino}\0${st.size}\0${st.mtimeMs}`;
  } catch {
    // A bare name or a missing file: nothing to cache on, so `--version` runs every time.
    return null;
  }
}

/** Resolves to the installed version when it is approved; throws otherwise, including when the version cannot be read. */
export async function assertApprovedClaude(bin: string, nodeEnv: string, opts: { approved?: string[]; run?: VersionRunner } = {}): Promise<string> {
  const approved = opts.approved ?? approvedClaudeVersions(nodeEnv);
  const key = statKey(bin);
  let version = key ? cache.get(key) : undefined;
  if (!version) {
    const r = await (opts.run ?? runVersion)(bin);
    const parsed = r.code === 0 ? parseClaudeVersion(r.stdout) : null;
    if (!parsed) throw new Error(`could not read the Claude Code version from ${bin} (exit ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim().slice(-200)}` : ''}); sessions run only on an approved version`);
    version = parsed;
    if (key) cache.set(key, version);
  }
  if (!approved.includes(version)) throw new Error(unapprovedMessage(version, approved));
  return version;
}

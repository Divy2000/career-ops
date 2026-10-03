import { execFile } from 'node:child_process';

export const NODE_FLOOR = '22.6.0';

export interface PreflightInput {
  claudeBin: string;
  nodeVersion: string;
  env: NodeJS.ProcessEnv;
  exec?: (cmd: string, args: string[]) => Promise<number>;
}

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export const KEYCHAIN_HELP =
  'Keychain item "career-ops-claude-token" is missing. Run: claude setup-token, then\n  security add-generic-password -U -a "$USER" -s career-ops-claude-token -w';

function exitCode(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    execFile(cmd, args, { shell: false, timeout: 8000 }, (err) => {
      if (!err) return resolve(0);
      const e = err as NodeJS.ErrnoException & { code?: number | string };
      resolve(e.code === 'ENOENT' ? 127 : typeof e.code === 'number' ? e.code : 1);
    });
  });
}

export function versionAtLeast(actual: string, floor: string): boolean {
  const a = actual.replace(/^v/, '').split('.').map(Number);
  const f = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = f[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export async function preflight(input: PreflightInput): Promise<PreflightResult> {
  const exec = input.exec ?? exitCode;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!versionAtLeast(input.nodeVersion, NODE_FLOOR)) {
    errors.push(`Node ${input.nodeVersion} is below the floor ${NODE_FLOOR}. Install a newer Node.`);
  }
  if ((await exec(input.claudeBin, ['--version'])) !== 0) {
    errors.push(`Claude CLI not runnable at "${input.claudeBin}". Install Claude Code or set CC_CLAUDE_BIN.`);
  }
  // Tests point CC_CLAUDE_BIN at the fake and must not depend on this machine's Keychain.
  const skipKeychain = input.env.NODE_ENV === 'test' && input.env.CC_SKIP_KEYCHAIN !== '0';
  if (!skipKeychain && (await exec('security', ['find-generic-password', '-s', 'career-ops-claude-token', '-w'])) !== 0) {
    errors.push(KEYCHAIN_HELP);
  }
  if (input.env.ANTHROPIC_API_KEY) {
    warnings.push('ANTHROPIC_API_KEY is set in this shell. Sessions force it empty and use the Keychain token.');
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function formatPreflight(r: PreflightResult): string {
  const lines = [...r.errors.map((e) => `error: ${e}`), ...r.warnings.map((w) => `warning: ${w}`)];
  return lines.join('\n');
}

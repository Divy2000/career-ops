// Standalone preflight: `npm run preflight`. Runs the same checks the supervisor runs at start (Node floor,
// a runnable claude, the Keychain token) and exits non-zero on any error, so the installer can verify an
// install without starting the server.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { preflight, formatPreflight, resolveClaudeBin, claudeCandidates, testHost } from './preflight.js';

export interface PreflightCliInput {
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
  /** Defaults: this machine's platform and managed settings (tests pin both). */
  platform?: NodeJS.Platform;
  managedSettings?: { dir?: string; plists?: string[] };
}

export async function runPreflightCli(input: PreflightCliInput): Promise<{ code: number; output: string }> {
  const claudeBin = resolveClaudeBin(input.env.CC_CLAUDE_BIN ?? 'claude', { env: input.env });
  // An explicit CC_CLAUDE_BIN is a decision; only an automatic pick warns about the alternatives.
  const alternatives = input.env.CC_CLAUDE_BIN ? [] : claudeCandidates('claude', { env: input.env });
  // The host the test pins (NODE_ENV=test only), as the supervisor's own preflight does; explicit inputs still win.
  const pinned = testHost(input.env);
  const pf = await preflight({ claudeBin, nodeVersion: input.nodeVersion, env: input.env, claudeCandidates: alternatives, platform: input.platform ?? pinned.platform, managedSettings: input.managedSettings ?? pinned.managedSettings });
  const report = formatPreflight(pf);
  const lines = [report, pf.ok ? 'preflight ok' : ''].filter(Boolean);
  return { code: pf.ok ? 0 : 1, output: lines.join('\n') };
}

const invoked = process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  runPreflightCli({ env: process.env, nodeVersion: process.version })
    .then(({ code, output }) => {
      (code === 0 ? console.log : console.error)(output);
      process.exit(code);
    })
    .catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    });
}

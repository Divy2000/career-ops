// `claude` for calls the daily job makes through scripts it cannot change: run-daily.sh puts a wrapper for this file
// first on PATH for the rank step, so rank-pipeline.mjs (upstream) gets a confined claude. A wrapped call keeps its
// prompt (its @-mentions made inert) and model and runs with no tools, no MCP servers, dontAsk and the session Read deny
// rules under the checkout and the data root (a mention that still got through attaches no secret), on an approved
// Claude Code with the autoupdater off; a flag that could widen it refuses the call. The real binary is CC_CLAUDE_BIN
// (absolute, never this file); with CC_CLAUDE_EXPECT (real path @ version, as the job's own check saw it) a binary
// changed since never runs.
// With CC_SHIM_REFUSALS, every refusal also appends its reason to that file: rank-pipeline.mjs catches a failed call
// and still exits 0, so the job reads the file to fail the step.
// Dev Chat cannot edit it (server/claude/** is protected).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildReadDenyRules, claudeVersionGate } from './confinement.mjs';
import { isMainModule } from '../../../../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../../../../path-resolver.mjs';

export const CLAUDE_SHIM_PATH = fileURLToPath(import.meta.url);
const CODE_ROOT = path.resolve(path.dirname(CLAUDE_SHIM_PATH), '../../../..');

/** Flags a wrapped call may keep, and whether each takes a value. */
const KEEP = { '-p': false, '--print': false, '--model': true, '--effort': true, '--output-format': true, '--max-turns': true, '--verbose': false };
/** Dropped outright: the confinement below decides permissions. */
const DROP = new Set(['--dangerously-skip-permissions']);
const NO_TOOLS = 'Bash,Edit,Write,MultiEdit,NotebookEdit,Read,Glob,Grep,WebFetch,WebSearch,Agent,Task,PowerShell';

/**
 * The prompt is untrusted posting text, and an @-mention attaches a file before any tool or hook runs: the same rule as
 * neutralizeFileMentions in invocation.ts (which this plain .mjs cannot import; a test keeps the two identical).
 */
function neutralizeFileMentions(text) {
  return text.replace(/(^|[^\w.+\-/:=?&%])@(?!\u2060)/g, '$1@\u2060');
}

/**
 * The confined argv for one wrapped call (with the Read deny rules under `roots`), or why it is refused. Any flag outside KEEP and DROP refuses the call:
 * permission flags such as --allowedTools take any number of values, so dropping one could swallow the prompt.
 * `--tools ""` (no tools) is followed by another flag, which ends its value list.
 */
export function confinedArgv(argv, roots = [CODE_ROOT, getCareerOpsRoot()]) {
  const kept = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (DROP.has(a)) continue;
    if (!a.startsWith('-')) {
      kept.push(neutralizeFileMentions(a));
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    if (!Object.hasOwn(KEEP, name)) return { reason: `claude-shim: ${name} is not allowed in a confined call (only -p, --print, --model, --effort, --output-format, --max-turns and --verbose are)` };
    kept.push(a);
    if (KEEP[name] && eq === -1) {
      if (argv[i + 1] === undefined) return { reason: `claude-shim: ${name} needs a value` };
      kept.push(argv[++i]);
    }
  }
  if (!kept.includes('-p') && !kept.includes('--print')) return { reason: 'claude-shim: only print mode (-p) calls are wrapped' };
  // Inline, so there is no settings file to remove; the rule source is the one session settings use.
  const settings = JSON.stringify({ permissions: { deny: buildReadDenyRules(roots) } });
  return { argv: [...kept, '--settings', settings, '--restricted', '--tools', '', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--disallowedTools', NO_TOOLS] };
}

function refuse(message, code = 1) {
  process.stderr.write(`${message}\n`);
  if (process.env.CC_SHIM_REFUSALS) fs.appendFileSync(process.env.CC_SHIM_REFUSALS, `${message}\n`);
  process.exit(code);
}

/** Signals a caller sends to stop the call; rank-pipeline.mjs's execFileSync timeout SIGTERMs only its direct child, this shim. */
const FORWARDED = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'];

/**
 * Runs the real binary and ends with its exit code or signal. A stop signal sent to the shim is passed on, so a caller
 * that kills the shim never leaves a paid claude run going on with no one to read it.
 */
function runReal(real, args, env) {
  const child = spawn(real, args, { stdio: 'inherit', env });
  const forward = (sig) => child.kill(sig);
  for (const sig of FORWARDED) process.on(sig, forward);
  child.on('error', (err) => {
    process.stderr.write(`claude-shim: cannot run ${real} (${err.message})\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      // Die of the same signal, so the caller sees what it would have without the shim.
      for (const sig of FORWARDED) process.off(sig, forward);
      process.kill(process.pid, signal);
      // Node ignores SIGPIPE and turns SIGUSR1 into the inspector, so the kill can leave the shim alive to exit 0.
      setImmediate(() => process.exit(128 + (os.constants.signals[signal] ?? 0)));
      return;
    }
    process.exit(code ?? 1);
  });
}

function main(argv) {
  const real = process.env.CC_CLAUDE_BIN;
  if (!real || !path.isAbsolute(real)) refuse('claude-shim: CC_CLAUDE_BIN must name the real claude by absolute path');
  let realPath;
  try {
    // .native asks the OS; fs.realpathSync collapses `..` on paper first, which through a symlinked folder is another file.
    realPath = fs.realpathSync.native(real);
  } catch (err) {
    refuse(`claude-shim: CC_CLAUDE_BIN ${real} cannot be resolved (${err.message})`);
  }
  if (realPath === fs.realpathSync.native(CLAUDE_SHIM_PATH)) refuse('claude-shim: CC_CLAUDE_BIN points at the shim itself');
  const env = { ...process.env, DISABLE_AUTOUPDATER: '1' };
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    runReal(real, argv, env);
    return;
  }
  const confined = confinedArgv(argv);
  if (confined.reason) refuse(confined.reason, 2);
  let gate;
  try {
    gate = claudeVersionGate(real);
  } catch (err) {
    refuse(`claude-shim: ${err.message}`);
  }
  if (gate.problem) refuse(`claude-shim: ${gate.problem}`, 3);
  const expected = process.env.CC_CLAUDE_EXPECT;
  if (expected && gate.identity !== expected) refuse(`claude-shim: Claude Code changed since the job checked it (${expected}, now ${gate.identity}); the call is not run`, 4);
  runReal(real, confined.argv, env);
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));

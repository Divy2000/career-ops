// `claude` for calls the daily job makes through scripts it cannot change: run-daily.sh puts a wrapper for this file
// first on PATH for the rank step, so rank-pipeline.mjs (upstream) gets a confined claude. A wrapped call keeps its
// prompt and model and runs with no tools, no MCP servers and dontAsk, on an approved Claude Code with the autoupdater
// off; a flag that could widen it refuses the call. The real binary is CC_CLAUDE_BIN (absolute, never this file).
// Dev Chat cannot edit it (server/claude/** is protected).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeVersionGate } from './confinement.mjs';
import { isMainModule } from '../../../../lib/is-main-module.mjs';

export const CLAUDE_SHIM_PATH = fileURLToPath(import.meta.url);

/** Flags a wrapped call may keep, and whether each takes a value. */
const KEEP = { '-p': false, '--print': false, '--model': true, '--output-format': true, '--max-turns': true, '--verbose': false };
/** Dropped outright: the confinement below decides permissions. */
const DROP = new Set(['--dangerously-skip-permissions']);
const NO_TOOLS = 'Bash,Edit,Write,MultiEdit,NotebookEdit,Read,Glob,Grep,WebFetch,WebSearch,Agent,Task,PowerShell';

/**
 * The confined argv for one wrapped call, or why it is refused. Any flag outside KEEP and DROP refuses the call:
 * permission flags such as --allowedTools take any number of values, so dropping one could swallow the prompt.
 * `--tools ""` (no tools) is followed by another flag, which ends its value list.
 */
export function confinedArgv(argv) {
  const kept = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (DROP.has(a)) continue;
    if (!a.startsWith('-')) {
      kept.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    if (!Object.hasOwn(KEEP, name)) return { reason: `claude-shim: ${name} is not allowed in a confined call (only -p, --print, --model, --output-format, --max-turns and --verbose are)` };
    kept.push(a);
    if (KEEP[name] && eq === -1) {
      if (argv[i + 1] === undefined) return { reason: `claude-shim: ${name} needs a value` };
      kept.push(argv[++i]);
    }
  }
  if (!kept.includes('-p') && !kept.includes('--print')) return { reason: 'claude-shim: only print mode (-p) calls are wrapped' };
  return { argv: [...kept, '--restricted', '--tools', '', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--disallowedTools', NO_TOOLS] };
}

function refuse(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function main(argv) {
  const real = process.env.CC_CLAUDE_BIN;
  if (!real || !path.isAbsolute(real)) refuse('claude-shim: CC_CLAUDE_BIN must name the real claude by absolute path');
  let realPath;
  try {
    realPath = fs.realpathSync(real);
  } catch (err) {
    refuse(`claude-shim: CC_CLAUDE_BIN ${real} cannot be resolved (${err.message})`);
  }
  if (realPath === fs.realpathSync(CLAUDE_SHIM_PATH)) refuse('claude-shim: CC_CLAUDE_BIN points at the shim itself');
  const env = { ...process.env, DISABLE_AUTOUPDATER: '1' };
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    const r = spawnSync(real, argv, { stdio: 'inherit', env });
    process.exit(r.status ?? 1);
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
  const r = spawnSync(real, confined.argv, { stdio: 'inherit', env });
  process.exit(r.status ?? 1);
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));

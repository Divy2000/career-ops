#!/usr/bin/env node
// Detached run wrapper: node wrapper.mjs <runDir> <cwd> <cmd> [args...]
// Spawns the real command in its own process group, appends stdout/stderr
// lines as NDJSON to <runDir>/raw.ndjson and writes <runDir>/exit.json when
// the command ends. The server spawns this detached so runs survive reloads.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const [runDir, cwd, cmd, ...args] = process.argv.slice(2);
if (!runDir || !cwd || !cmd) {
  console.error('usage: wrapper.mjs <runDir> <cwd> <cmd> [args...]');
  process.exit(64);
}

const rawPath = path.join(runDir, 'raw.ndjson');
const out = fs.createWriteStream(rawPath, { flags: 'a' });
let seq = 0;
// The Claude OAuth token travels in env only; it never reaches the stored log.
const secret = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
const write = (stream, line) => {
  seq += 1;
  const text = secret ? line.split(secret).join('[redacted]') : line;
  out.write(JSON.stringify({ seq, ts: new Date().toISOString(), stream, line: text }) + '\n');
};

// A cancel can come before this wrapper has a signal handler (while node is still starting, a SIGTERM would end it
// with no exit record and, later, an orphaned command): the runner leaves a cancel file instead, read before the
// command is spawned and again once it is recorded in wrapper.json (the runner signals only once that file exists).
const cancelPath = path.join(runDir, 'cancel');
let child = null;
// Forward a termination of the wrapper itself to the whole process group.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      /* already gone */
    }
  });
}
if (fs.existsSync(cancelPath)) {
  out.end(() => {
    fs.writeFileSync(path.join(runDir, 'exit.json'), JSON.stringify({ code: null, signal: 'SIGTERM', endedAt: new Date().toISOString() }));
    process.exit(0);
  });
} else {
  child = spawn(cmd, args, { cwd, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  fs.writeFileSync(path.join(runDir, 'wrapper.json'), JSON.stringify({ wrapperPid: process.pid, childPid: child.pid, startedAt: new Date().toISOString() }));

  let open = 2;
  let exit = null;
  const done = (code, signal) => {
    if (open > 0) return;
    out.end(() => {
      fs.writeFileSync(path.join(runDir, 'exit.json'), JSON.stringify({ code, signal, endedAt: new Date().toISOString() }));
      process.exit(0);
    });
  };
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    const rl = readline.createInterface({ input: stream });
    rl.on('line', (line) => write(name, line));
    rl.on('close', () => {
      open -= 1;
      if (exit) done(exit.code, exit.signal);
    });
  }
  child.on('error', (err) => {
    write('stderr', `spawn failed: ${err.message}`);
    open = 0;
    done(127, null);
  });
  child.on('exit', (code, signal) => {
    exit = { code, signal };
    done(code, signal);
  });
  // A cancel written while the command was being spawned: the runner did not see wrapper.json yet, so it is ours to act on.
  if (fs.existsSync(cancelPath)) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

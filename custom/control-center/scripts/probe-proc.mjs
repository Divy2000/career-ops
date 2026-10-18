// How both Claude CLI probes run a CLI process and end it (invariant 11 in claude-probe-reads.invariants.md): each runs
// as the leader of its own process group, and every way it ends (its own exit, its timeout, a signal) goes through
// stopGroups, so nothing it forked (hooks, Bash-tool commands, a wrapper's children) outlives it.
import { spawn } from 'node:child_process';

export const STOP_MS = 5_000;

/**
 * Kills each child's process group until it has no process left, or `ms` pass. One group kill is not enough under
 * load: a member forked while it ran can miss it, and one preempted mid-write still acts after it, so a cleanup right
 * after the kill can race a call that creates a project folder or transcript behind it. A child that never got a pid
 * (its spawn failed) has no group and is only killed directly. Returns the PIDs of the groups that may remain.
 */
export async function stopGroups(children, ms = STOP_MS) {
  const pending = new Set([...children].filter((c) => Number.isInteger(c.pid)));
  for (const child of children) if (!pending.has(child)) child.kill('SIGKILL');
  const deadline = Date.now() + ms;
  for (;;) {
    for (const child of pending) {
      try {
        // Signal 0 only asks whether the group still has a member; ESRCH from either call means it has none.
        process.kill(-child.pid, 0);
        process.kill(-child.pid, 'SIGKILL');
      } catch (err) {
        if (err?.code === 'ESRCH') pending.delete(child);
      }
    }
    if (!pending.size || Date.now() >= deadline) return [...pending].map((c) => c.pid);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Runs `bin args` as the leader of a new process group and resolves only once that group has no process left, in
 * spawnSync's result shape plus `left` (the group's pid when 5 s of kills did not empty it) and `child`. A spawn failure
 * resolves with `error` and no pid; after `timeoutMs` the group is stopped and `error.code` is ETIMEDOUT. `track` holds
 * the child from its spawn until its group is gone, so a signal handler can stop it. Never rejects.
 * @param {string} bin
 * @param {string[]} args
 * @param {{ timeoutMs: number, track?: Set<import('node:child_process').ChildProcess> } & import('node:child_process').SpawnOptions} opts
 */
export function runGroup(bin, args, { timeoutMs, track, ...opts }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    track?.add(child);
    let stdout = '';
    let stderr = '';
    let error;
    // On EMFILE/ENFILE Node reports the spawn failure before it creates the pipes, so they can be null.
    child.stdout?.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr?.setEncoding('utf8').on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      error ??= Object.assign(new Error(`${bin} timed out after ${timeoutMs / 1000}s`), { code: 'ETIMEDOUT' });
      void stopGroups([child]);
    }, timeoutMs);
    let ended = false;
    const end = async (status, signal) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      const left = Number.isInteger(child.pid) ? await stopGroups([child]) : [];
      track?.delete(child);
      resolve({ child, status, signal, stdout, stderr, error, left });
    };
    // A spawn failure (ENOENT, EAGAIN, EMFILE) emits 'error' with no pid and no 'close'. An 'error' after a successful
    // spawn (a failed kill) leaves the child running, so 'close' ends it.
    child.on('error', (err) => {
      if (child.pid === undefined) {
        error = err;
        void end(null, null);
      } else stderr += `\n${err?.message ?? err}`;
    });
    child.on('close', (status, signal) => void end(status, signal));
  });
}

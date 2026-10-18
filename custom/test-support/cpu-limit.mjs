// Runs a command for a spec, bounded by CPU time rather than a tight wall-clock timeout. A command stuck in a loop is
// killed (SIGXCPU) once it, or any one process it starts, has used `cpuSeconds` of CPU time: a tight wall-clock
// timeout instead killed healthy runs on a loaded machine, where a run that needs well under a second of CPU took
// longer than 30 s. `hangMs` is only the backstop for what the CPU limit cannot see (a child that blocks, a loop of
// short-lived children), sized so that no healthy run reaches it however loaded the machine is. Other options go to
// spawnSync unchanged.
import { spawnSync } from 'node:child_process';

export function spawnCpuLimited(command, args, { cpuSeconds = 30, hangMs = 600_000, ...options } = {}) {
  return spawnSync('bash', ['-c', 'ulimit -t "$1" && shift && exec "$@"', 'bash', String(cpuSeconds), command, ...args], { encoding: 'utf8', ...options, timeout: hangMs });
}

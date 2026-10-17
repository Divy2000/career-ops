// Runs are detached so they outlive the server (app.close() leaves them going): a test that removes its data root while
// a run's wrapper is still writing its folder fails with ENOTEMPTY. Wait for every started run to end first.
import fs from 'node:fs';
import path from 'node:path';
import { pidAlive } from '../../server/runner/runner.js';
import { RunStore } from '../../server/runner/store.js';

function wrapperPids(dir: string): number[] {
  try {
    const w = JSON.parse(fs.readFileSync(path.join(dir, 'wrapper.json'), 'utf8')) as { wrapperPid?: number; childPid?: number };
    return [w.wrapperPid, w.childPid].filter((p): p is number => typeof p === 'number');
  } catch {
    return [];
  }
}

/** Resolves once every run on the data root that was spawned has written its exit record and its processes are gone. */
export async function runsEnded(dataRoot: string, timeoutMs = 30_000): Promise<void> {
  const store = new RunStore(dataRoot);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const going = store.list().filter((run) => {
      const dir = store.dirOf(run.id);
      const pids = [run.wrapperPid, run.childPid, ...wrapperPids(dir)].filter((p): p is number => typeof p === 'number');
      if (!pids.length) return false;
      return !fs.existsSync(path.join(dir, 'exit.json')) || pids.some(pidAlive);
    });
    if (!going.length) return;
    if (Date.now() > deadline) throw new Error(`runs still going on ${dataRoot}: ${going.map((r) => r.id).join(', ')}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

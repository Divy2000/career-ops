// A second server process for runner tests: a real Runner on the given data root that starts one run and holds still
// right after spawning its wrapper, before it records the run as running (the window two processes can race in).
// usage: node --import tsx runner-process.ts <dataRoot> <signalDir> <startRequestJson> [nodePath]
// nodePath: what runs the wrapper (a stand-in that never records anything, for a crash before the wrapper does).
// It writes <signalDir>/in-window once there and goes on when <signalDir>/go exists; the test may SIGKILL it instead.
import fs from 'node:fs';
import path from 'node:path';
import { Runner, processStartTime } from '../../server/runner/runner.js';
import { EventBus } from '../../server/watch/bus.js';

const [dataRoot, signalDir, request, nodePath] = process.argv.slice(2);
if (!dataRoot || !signalDir || !request) {
  console.error('usage: runner-process.ts <dataRoot> <signalDir> <startRequestJson> [nodePath]');
  process.exit(64);
}
const gate = new Int32Array(new SharedArrayBuffer(4));
let held = false;
const runner = new Runner(dataRoot, new EventBus(), {
  pollMs: 50,
  claudeSlots: 1,
  ...(nodePath ? { nodePath } : {}),
  // The runner reads its wrapper's start time between spawning it and writing `running`: hold there, once.
  procStart: (pid) => {
    if (pid !== process.pid && !held) {
      held = true;
      fs.writeFileSync(path.join(signalDir, 'in-window'), String(pid));
      while (!fs.existsSync(path.join(signalDir, 'go'))) Atomics.wait(gate, 0, 0, 20);
    }
    return processStartTime(pid);
  },
});
runner.start(JSON.parse(request) as Parameters<Runner['start']>[0]);
// Stay up to track the run, as a server does, until the test ends this process.
setInterval(() => {}, 1000);

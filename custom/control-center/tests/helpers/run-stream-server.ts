// A real Control Center server streaming one gated run (see gated-run.ts), for web tests that drive the Runs log
// through HttpEventSource. Web tests load it with a non-literal dynamic import so the web typecheck never follows it
// into server code; RunStreamServer in the web test mirrors its shape.
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo, Socket } from 'node:net';
import { makeTestApp, PACKAGE_ROOT } from './app.js';
import { gatedScript } from './gated-run.js';
import { tempDir } from './tmp.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startRunStreamServer() {
  const t = await makeTestApp();
  const gate = path.join(tempDir('cc-run-log-'), 'go');
  const run = t.runner.start({ actionId: 'test.gated', label: 'Full ATS scan', cost: 'free', resources: [], claude: false, params: {}, cmd: { bin: process.execPath, args: ['-e', gatedScript(gate)], cwd: PACKAGE_ROOT } });
  const sockets = new Set<Socket>();
  t.app.server.on('connection', (s: Socket) => sockets.add(s));
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = t.app.server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    headers: t.authed,
    run,
    /** Cuts every open connection at the server, as a blue/green reload or a sleep would. */
    dropConnections: () => sockets.forEach((s) => s.destroy()),
    /** Lets the run print its remaining lines and exit. */
    openGate: () => fs.writeFileSync(gate, ''),
    close: async () => {
      fs.writeFileSync(gate, '');
      const deadline = Date.now() + 10_000;
      while (!t.runner.store.read(run.id)?.endedAt && Date.now() < deadline) await wait(50);
      await t.close();
    },
  };
}

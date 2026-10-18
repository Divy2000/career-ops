// R34-srv-core-L1-01: the Release report numbers guard for numbers reserved but not yet on a session record lived in
// this process's memory only, so during a blue/green handover a peer server's Batch evaluate could have its numbers
// released (and handed out again) while its sessions were still starting. The peer here is a real second process
// holding the reservation through the same registry module.
import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFixtureRoot, makeTestApp, type TestApp } from '../helpers/app.js';
import { runsEnded } from '../helpers/runs.js';
import { tempDir } from '../helpers/tmp.js';
import { beginTakingReportNums } from '../../server/actions/registry.js';

const CC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY = path.join(CC_DIR, 'server/actions/registry.ts');

const release = (app: TestApp, range: string) => app.app.inject({ method: 'POST', url: '/api/actions/pipeline.releaseReportNums', headers: app.authedWrite, payload: { params: { range } } });

const waitForContent = async (file: string) => {
  for (let i = 0; i < 100 && !fs.readFileSync(file, 'utf8'); i++) await new Promise((r) => setTimeout(r, 20));
};

type PeerHold = 'taking' | { unrecorded: number } | 'releasing';

type Peer = { exit(): Promise<void> };

/** A second server process on the same data root holding a reservation as the session manager or a release does. */
async function peerHolding(dataRoot: string, hold: PeerHold): Promise<Peer> {
  const ready = path.join(tempDir('cc-r34-peer-'), 'ready');
  const tmp = tempDir('cc-r34-peer-tsx-');
  const act =
    hold === 'taking'
      ? 'await m.beginTakingReportNums(root);'
      : hold === 'releasing'
        ? 'm.unrecordedFor(root).releasing.add(new Promise(() => {}));'
        : `const e = await m.beginTakingReportNums(root); e.nums.add(${hold.unrecorded}); e.taking -= 1;`;
  const script = `const m = await import(${JSON.stringify(REGISTRY)}); const root = ${JSON.stringify(dataRoot)}; ${act} (await import('node:fs')).writeFileSync(${JSON.stringify(ready)}, (await import('node:os')).tmpdir()); setInterval(() => {}, 1000);`;
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: CC_DIR, stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH ?? '', TMPDIR: tmp, TEMP: tmp, TMP: tmp } });
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr += String(d)));
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(ready)) {
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`the peer process did not get ready: ${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  // tsx keeps its IPC dir (tsx-<uid>) in the peer's temp dir: it must be inside this run's, where the leak guard sees it.
  await waitForContent(ready);
  const peerTmp = fs.readFileSync(ready, 'utf8');
  if (!peerTmp.startsWith(os.tmpdir())) {
    child.kill('SIGKILL');
    throw new Error(`the peer process uses ${peerTmp} as its temp dir, outside this run's ${os.tmpdir()}`);
  }
  return {
    async exit() {
      child.kill('SIGKILL');
      await exited;
    },
  };
}

describe('Release report numbers beside a peer server process reserving them (R34-srv-core-L1-01)', () => {
  it('given another process taking a reservation, when a release is asked for here, then it is refused (409) until that process is gone', async () => {
    const dataRoot = copyFixtureRoot();
    const app = await makeTestApp({ dataRoot });
    let peer: Peer | undefined;
    try {
      peer = await peerHolding(dataRoot, 'taking');
      const refused = await release(app, '40-45');
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error).toMatch(/reserving report numbers/);
      await peer.exit();
      const ok = await release(app, '40-45');
      expect(ok.statusCode, ok.body).toBe(200);
    } finally {
      await peer?.exit();
      await app.close();
      await runsEnded(dataRoot);
    }
  });

  it('given another process holding a number reserved for a session not recorded yet, when that number is released here, then it is refused (409) and the sentinel stays', async () => {
    const dataRoot = copyFixtureRoot();
    const app = await makeTestApp({ dataRoot });
    const sentinel = path.join(dataRoot, 'reports', '047-RESERVED.md');
    fs.writeFileSync(sentinel, '');
    let peer: Peer | undefined;
    try {
      peer = await peerHolding(dataRoot, { unrecorded: 47 });
      const refused = await release(app, '45-48');
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error).toMatch(/Report 47 is reserved for a session that is starting/);
      expect(fs.existsSync(sentinel)).toBe(true);
      // A number the peer does not hold is still released.
      expect((await release(app, '50')).statusCode).toBe(200);
    } finally {
      await peer?.exit();
      await app.close();
      await runsEnded(dataRoot);
    }
  });

  it('given another process running a release, when a reservation begins here, then it waits until that release has ended', async () => {
    const dataRoot = copyFixtureRoot();
    const peer = await peerHolding(dataRoot, 'releasing');
    let begun = false;
    const taking = beginTakingReportNums(dataRoot).then((entry) => {
      begun = true;
      return entry;
    });
    try {
      // Long enough for several polls of the peer's record; the wait must still be on.
      await new Promise((r) => setTimeout(r, 400));
      expect(begun).toBe(false);
      await peer.exit();
      await taking;
      expect(begun).toBe(true);
    } finally {
      await peer.exit();
      (await taking).taking -= 1;
    }
  });
});

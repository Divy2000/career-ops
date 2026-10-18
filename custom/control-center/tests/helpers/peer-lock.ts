// A second process holding the cross-process file lock (core pipeline-lock.mjs) on one file, the way the other server
// child of a blue/green handover holds it while it saves. release() writes the peer's content (when given) and then
// lets the lock go, so a save waiting on the lock has to read the file again before it writes.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PEER = `
const [lockUrl, file] = process.argv.slice(1);
const fs = await import('node:fs');
const { acquirePipelineLock } = await import(lockUrl);
const lock = await acquirePipelineLock(file, { timeoutMs: 5000, retryMs: 20 });
process.stdout.write('READY\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const nl = buf.indexOf('\\n');
  if (nl < 0) return;
  const { content } = JSON.parse(buf.slice(0, nl));
  if (typeof content === 'string') fs.writeFileSync(file, content);
  lock.release();
  process.stdout.write('DONE\\n');
  process.exit(0);
});
`;

export interface PeerLock {
  /** Writes `content` to the file (null: leaves it), releases the lock and waits for the peer to exit. */
  release(content: string | null): Promise<void>;
  /** Kills the peer if it is still alive; for finally blocks. */
  stop(): void;
}

function waitFor(child: ChildProcess, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const onOut = (c: Buffer) => {
      out += c.toString();
      if (out.includes(`${line}\n`)) {
        child.stdout!.off('data', onOut);
        resolve();
      }
    };
    child.stdout!.on('data', onOut);
    child.stderr!.on('data', (c: Buffer) => (err += c.toString()));
    child.once('exit', (code) => {
      if (!out.includes(`${line}\n`)) reject(new Error(`lock peer exited ${code} before ${line}: ${err}`));
    });
  });
}

export async function holdPeerLock(codeRoot: string, file: string): Promise<PeerLock> {
  const lockUrl = pathToFileURL(path.join(codeRoot, 'pipeline-lock.mjs')).href;
  // An allowlisted env: nothing of the test runner's credentials or repo overrides reaches the peer.
  const child = spawn(process.execPath, ['--input-type=module', '-e', PEER, lockUrl, file], { env: { PATH: process.env.PATH ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await waitFor(child, 'READY');
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  }
  return {
    async release(content) {
      const done = waitFor(child, 'DONE');
      child.stdin!.write(`${JSON.stringify({ content })}\n`);
      await done;
      if (child.exitCode === null) await new Promise((r) => child.once('exit', r));
    },
    stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
}

/** Whether `p` settles within `ms`: the window a save without the lock would need to finish while the peer holds it. */
export async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const settled = await Promise.race([p.then(() => true, () => true), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms)))]);
  clearTimeout(timer);
  return settled;
}

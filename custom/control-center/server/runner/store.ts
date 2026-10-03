import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'lost';
export type Cost = 'free' | 'network' | 'tokens';

export interface RunMeta {
  id: string;
  actionId: string;
  label: string;
  cost: Cost;
  resources: string[];
  claude: boolean;
  cmd: { bin: string; args: string[]; cwd: string };
  params: unknown;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  wrapperPid: number | null;
  childPid: number | null;
  error: string | null;
}

export interface RawLine {
  seq: number;
  ts: string;
  stream: 'stdout' | 'stderr';
  line: string;
}

export const DEFAULT_RETENTION = 500;

export function runsDir(dataRoot: string): string {
  return path.join(dataRoot, 'data', 'control-center', 'runs');
}

export function newRunId(): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${ts}-${crypto.randomBytes(3).toString('hex')}`;
}

export class RunStore {
  constructor(
    private dataRoot: string,
    private retention = DEFAULT_RETENTION,
  ) {
    fs.mkdirSync(runsDir(dataRoot), { recursive: true });
  }

  dirOf(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('bad run id');
    return path.join(runsDir(this.dataRoot), id);
  }

  create(meta: Omit<RunMeta, 'id' | 'createdAt' | 'status' | 'startedAt' | 'endedAt' | 'exitCode' | 'signal' | 'wrapperPid' | 'childPid' | 'error'>): RunMeta {
    const full: RunMeta = {
      ...meta,
      id: newRunId(),
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      exitCode: null,
      signal: null,
      wrapperPid: null,
      childPid: null,
      error: null,
    };
    fs.mkdirSync(this.dirOf(full.id), { recursive: true });
    this.write(full);
    this.prune();
    return full;
  }

  write(meta: RunMeta): void {
    const p = path.join(this.dirOf(meta.id), 'meta.json');
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
    fs.renameSync(tmp, p);
  }

  read(id: string): RunMeta | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dirOf(id), 'meta.json'), 'utf8')) as RunMeta;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  list(): RunMeta[] {
    const out: RunMeta[] = [];
    for (const name of fs.readdirSync(runsDir(this.dataRoot))) {
      const meta = this.read(name);
      if (meta) out.push(meta);
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  readExit(id: string): { code: number | null; signal: string | null; endedAt: string } | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dirOf(id), 'exit.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  readWrapper(id: string): { wrapperPid: number; childPid: number } | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dirOf(id), 'wrapper.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  /** Raw lines with seq > afterSeq, plus the byte offset reached (for tailing). */
  readRaw(id: string, afterSeq = 0, fromOffset = 0): { lines: RawLine[]; offset: number } {
    const p = path.join(this.dirOf(id), 'raw.ndjson');
    let fd: number;
    try {
      fd = fs.openSync(p, 'r');
    } catch {
      return { lines: [], offset: fromOffset };
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= fromOffset) return { lines: [], offset: fromOffset };
      const buf = Buffer.alloc(size - fromOffset);
      fs.readSync(fd, buf, 0, buf.length, fromOffset);
      const text = buf.toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      if (lastNl === -1) return { lines: [], offset: fromOffset };
      const complete = text.slice(0, lastNl);
      const lines: RawLine[] = [];
      for (const l of complete.split('\n')) {
        if (!l) continue;
        try {
          const parsed = JSON.parse(l) as RawLine;
          if (parsed.seq > afterSeq) lines.push(parsed);
        } catch {
          /* torn line: skipped */
        }
      }
      return { lines, offset: fromOffset + Buffer.byteLength(complete, 'utf8') + 1 };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Keep the newest `retention` finished runs; running or queued runs are never pruned. */
  prune(): number {
    const all = this.list();
    const finished = all.filter((r) => r.status !== 'running' && r.status !== 'queued');
    let removed = 0;
    for (const old of finished.slice(this.retention)) {
      fs.rmSync(this.dirOf(old.id), { recursive: true, force: true });
      removed++;
    }
    return removed;
  }
}

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
  /**
   * When the wrapper and the child started, in seconds since the epoch (processStartTime): a live PID only counts as ours
   * when its start time matches. A string is the earlier format (ps text in that server's TZ and locale): PID only.
   */
  wrapperStartedAt?: number | string | null;
  childStartedAt?: number | string | null;
  error: string | null;
  /** Input files the app wrote for this run under data/control-center/tmp, removed when it ends (absent on older runs). */
  tmpInputs?: string[];
  /** What one exit code of this command means (see ExitMeaning); absent: 0 is done, anything else failed. */
  exitMeaning?: ExitMeaning;
}

/**
 * A command whose exit code says more than "failed": check-liveness.mjs exits 1 when it found an expired posting (a
 * finished check: done, unless it wrote to stderr, which only its errors do), fetch-jd.mjs exits 1 silently when no
 * known job-board API covers the URL (failed, with the reason it does not print).
 */
export interface ExitMeaning {
  code: number;
  status: 'done' | 'failed';
  /** The run's error when it ends failed this way. */
  error?: string;
  /** Only when the run wrote nothing to stderr (a script that reports its own errors there). */
  onlyWithoutStderr?: boolean;
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

let lastStamp = 0;
/** Strictly increasing within the process, so lists and pruning order runs created in the same millisecond deterministically. */
export function monotonicIso(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

const RUN_ID = /^[\w-]+$/;
/** The file in a run's folder that asks its wrapper to stop (wrapper.mjs reads the same name). */
export const CANCEL_FILE = 'cancel';

export class RunStore {
  constructor(
    private dataRoot: string,
    private retention = DEFAULT_RETENTION,
  ) {
    fs.mkdirSync(runsDir(dataRoot), { recursive: true });
  }

  /** App settings change the cap live; the next prune applies it. */
  setRetention(n: number): void {
    this.retention = n;
  }

  dirOf(id: string): string {
    if (!RUN_ID.test(id)) throw new Error('bad run id');
    return path.join(runsDir(this.dataRoot), id);
  }

  create(meta: Omit<RunMeta, 'id' | 'createdAt' | 'status' | 'startedAt' | 'endedAt' | 'exitCode' | 'signal' | 'wrapperPid' | 'childPid' | 'error'>): RunMeta {
    const full: RunMeta = {
      ...meta,
      id: newRunId(),
      status: 'queued',
      createdAt: monotonicIso(),
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
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw err;
    }
  }

  list(): RunMeta[] {
    const out: RunMeta[] = [];
    // Only run folders: Finder drops .DS_Store here, and anything else stray is not a run either.
    for (const entry of fs.readdirSync(runsDir(this.dataRoot), { withFileTypes: true })) {
      if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
      const meta = this.read(entry.name);
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

  /** Asks the run's wrapper to stop: it reads this before it spawns the command and once more after recording it. */
  requestCancel(id: string): void {
    fs.writeFileSync(path.join(this.dirOf(id), CANCEL_FILE), new Date().toISOString());
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

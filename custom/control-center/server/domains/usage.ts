// Read-only token usage from Claude Code's local logs (~/.claude/projects/**/*.jsonl):
// input + output + cache-creation tokens over the last 5 hours and 7 days.
import fs from 'node:fs';
import path from 'node:path';

export interface UsageWindow {
  tokens: number;
  input: number;
  output: number;
  cacheCreation: number;
  messages: number;
}

export interface UsageRead {
  kind: 'ok' | 'missing';
  dir: string;
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  files: number;
  computedAt: string;
}

const FIVE_HOURS = 5 * 3_600_000;
const SEVEN_DAYS = 7 * 86_400_000;

const emptyWindow = (): UsageWindow => ({ tokens: 0, input: 0, output: 0, cacheCreation: 0, messages: 0 });

interface Listed {
  file: string;
  ino: number;
  size: number;
  mtimeMs: number;
}

function listJsonl(dir: string, since: number, out: Listed[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) listJsonl(abs, since, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try {
        const st = fs.statSync(abs);
        if (st.mtimeMs >= since) out.push({ file: abs, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
}

interface UsageLine {
  timestamp?: string;
  requestId?: string;
  message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number } };
}

/** One usage line of a transcript: what the meter sums. */
interface UsageRecord {
  key: string;
  ts: number;
  input: number;
  output: number;
  cache: number;
}

/** What a transcript has given so far: its records, and how far it was read (the end of its last whole line). */
interface FileState {
  ino: number;
  size: number;
  mtimeMs: number;
  offset: number;
  records: UsageRecord[];
}

// Per projects dir, per transcript. Claude Code only appends to a transcript, so a refresh reads what a file gained
// since the last one and nothing of a file that did not change: the meter refreshes every minute on every page, and
// re-reading every transcript of the week each time stalled the server's one thread as the transcripts grew.
const scanned = new Map<string, Map<string, FileState>>();

const CHUNK = 4 * 1024 * 1024;

function recordOf(line: string, file: string): UsageRecord | null {
  if (!line.includes('"usage"')) return null;
  let o: UsageLine;
  try {
    o = JSON.parse(line) as UsageLine;
  } catch {
    return null;
  }
  const u = o.message?.usage;
  const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
  if (!u || Number.isNaN(ts)) return null;
  return { key: o.requestId ?? `${file}:${ts}:${u.input_tokens}:${u.output_tokens}`, ts, input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cache: u.cache_creation_input_tokens ?? 0 };
}

/**
 * Reads the whole lines of `file` from `from` to `to`, in chunks (so no single string nears V8's limit), into
 * `records`; returns where the last whole line ends, so a line still being written is read again next time.
 */
function readWholeLines(file: string, from: number, to: number, records: UsageRecord[]): number {
  const fd = fs.openSync(file, 'r');
  try {
    let pos = from;
    let done = from;
    let carry = Buffer.alloc(0);
    while (pos < to) {
      const buf = Buffer.alloc(Math.min(CHUNK, to - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) break;
      pos += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const end = data.lastIndexOf(0x0a);
      if (end === -1) {
        carry = Buffer.from(data);
        continue;
      }
      for (const line of data.subarray(0, end).toString('utf8').split('\n')) {
        const r = recordOf(line, file);
        if (r) records.push(r);
      }
      carry = Buffer.from(data.subarray(end + 1));
      done = pos - carry.length;
    }
    return done;
  } finally {
    fs.closeSync(fd);
  }
}

export function computeUsage(projectsDir: string, now: number = Date.now()): UsageRead {
  const computedAt = new Date(now).toISOString();
  if (!fs.existsSync(projectsDir)) {
    scanned.delete(projectsDir);
    return { kind: 'missing', dir: projectsDir, fiveHour: emptyWindow(), sevenDay: emptyWindow(), files: 0, computedAt };
  }
  const since = now - SEVEN_DAYS;
  const listed: Listed[] = [];
  listJsonl(projectsDir, since, listed);
  const prev = scanned.get(projectsDir) ?? new Map<string, FileState>();
  const next = new Map<string, FileState>();
  for (const l of listed) {
    let st = prev.get(l.file);
    // A new file, another file in its place, or one rewritten shorter: read it from the start.
    if (!st || st.ino !== l.ino || l.size < st.offset) st = { ino: l.ino, size: 0, mtimeMs: 0, offset: 0, records: [] };
    if (st.size !== l.size || st.mtimeMs !== l.mtimeMs) {
      try {
        st.offset = readWholeLines(l.file, st.offset, l.size, st.records);
      } catch {
        // Unreadable now (vanished, no permission): keep what it gave so far; the next refresh tries again.
        next.set(l.file, st);
        continue;
      }
      st.size = l.size;
      st.mtimeMs = l.mtimeMs;
    }
    // Lines older than the week never count again.
    if (st.records.some((r) => r.ts < since)) st.records = st.records.filter((r) => r.ts >= since);
    next.set(l.file, st);
  }
  scanned.set(projectsDir, next);
  const fiveHour = emptyWindow();
  const sevenDay = emptyWindow();
  // Claude Code writes one line per content block; they share a requestId and repeat the same usage.
  const seen = new Set<string>();
  const add = (w: UsageWindow, r: UsageRecord) => {
    w.input += r.input;
    w.output += r.output;
    w.cacheCreation += r.cache;
    w.tokens += r.input + r.output + r.cache;
    w.messages += 1;
  };
  for (const st of next.values()) {
    for (const r of st.records) {
      if (seen.has(r.key)) continue;
      seen.add(r.key);
      if (r.ts >= since) add(sevenDay, r);
      if (r.ts >= now - FIVE_HOURS) add(fiveHour, r);
    }
  }
  return { kind: 'ok', dir: projectsDir, fiveHour, sevenDay, files: listed.length, computedAt };
}

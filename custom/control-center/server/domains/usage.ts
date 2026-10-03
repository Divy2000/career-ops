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

function listJsonl(dir: string, since: number, out: string[]): void {
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
        if (fs.statSync(abs).mtimeMs >= since) out.push(abs);
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

export function computeUsage(projectsDir: string, now: number = Date.now()): UsageRead {
  const computedAt = new Date(now).toISOString();
  if (!fs.existsSync(projectsDir)) return { kind: 'missing', dir: projectsDir, fiveHour: emptyWindow(), sevenDay: emptyWindow(), files: 0, computedAt };
  const files: string[] = [];
  listJsonl(projectsDir, now - SEVEN_DAYS, files);
  const fiveHour = emptyWindow();
  const sevenDay = emptyWindow();
  // Claude Code writes one line per content block; they share a requestId and repeat the same usage.
  const seen = new Set<string>();
  const add = (w: UsageWindow, u: NonNullable<NonNullable<UsageLine['message']>['usage']>) => {
    const input = u.input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const cache = u.cache_creation_input_tokens ?? 0;
    w.input += input;
    w.output += output;
    w.cacheCreation += cache;
    w.tokens += input + output + cache;
    w.messages += 1;
  };
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue;
      let o: UsageLine;
      try {
        o = JSON.parse(line) as UsageLine;
      } catch {
        continue;
      }
      const u = o.message?.usage;
      const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
      if (!u || Number.isNaN(ts)) continue;
      const key = o.requestId ?? `${file}:${ts}:${u.input_tokens}:${u.output_tokens}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (ts >= now - SEVEN_DAYS) add(sevenDay, u);
      if (ts >= now - FIVE_HOURS) add(fiveHour, u);
    }
  }
  return { kind: 'ok', dir: projectsDir, fiveHour, sevenDay, files: files.length, computedAt };
}

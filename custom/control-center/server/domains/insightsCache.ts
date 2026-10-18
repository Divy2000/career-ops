// Insights scripts (JSON by default, spec 1d) cached by the mtimes of their inputs and code, and the local day.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerConfig } from '../config.js';
import { cliScriptPath, type CliId } from '../core/adapter.js';
import type { Exec } from '../routes/system.js';
import { localDate } from '../../shared/local-date.js';
import { resolveTrackerFile } from './trackerPath.js';

export const INSIGHT_SCRIPTS: Record<string, { cli: CliId; label: string }> = {
  funnelVelocity: { cli: 'funnelVelocity', label: 'Funnel velocity' },
  analyzePatterns: { cli: 'analyzePatterns', label: 'Patterns' },
  salaryGap: { cli: 'salaryGap', label: 'Salary gap' },
  upskill: { cli: 'upskill', label: 'Upskill map' },
  rejectionLatency: { cli: 'rejectionLatency', label: 'Rejection latency' },
  processQuality: { cli: 'processQuality', label: 'Process quality' },
  weeklyDigest: { cli: 'weeklyDigest', label: 'Weekly digest' },
  assessmentLog: { cli: 'assessmentLog', label: 'Assessment log' },
  storyProvenance: { cli: 'storyProvenanceCheck', label: 'Story provenance' },
  detectReposts: { cli: 'detectReposts', label: 'Reposts' },
  companyHistory: { cli: 'companyHistory', label: 'Company history' },
};

export type InsightScript = keyof typeof INSIGHT_SCRIPTS;

export interface InsightRead {
  script: string;
  label: string;
  kind: 'ok' | 'failed';
  computedAt: string;
  inputsKey: string;
  exit: number;
  json: unknown;
  text: string;
  fromCache: boolean;
}

/** Files the Insights scripts read, relative to the data root; the watcher refreshes Insights on each. */
export const INSIGHTS_INPUT_FILES: readonly string[] = [
  'cv.md',
  'article-digest.md',
  'portals.yml',
  'config/profile.yml',
  'config/benchmarks.yml',
  'data/applications.md',
  'data/status-log.tsv',
  'applications.md',
  'status-log.tsv',
  'data/scan-history.tsv',
  'data/pipeline.md',
  'data/follow-ups.md',
  'data/blacklist.md',
  'data/assessments.tsv',
  'data/salary-observations.tsv',
  'data/active-interviews.md',
  'active-interviews.md',
];
/** Folders whose files the scripts read; each file counts, since editing one in place leaves its folder's time alone. */
export const INSIGHTS_INPUT_DIRS: readonly string[] = ['reports', 'interview-prep', 'interview-prep/sessions', 'jds'];

const mtimeOf = (file: string): string => {
  try {
    return String(Math.round(fs.statSync(file).mtimeMs));
  } catch {
    return '-';
  }
};

function dirKey(dir: string, only?: RegExp): string {
  let names: string[];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && (!only || only.test(e.name)))
      .map((e) => e.name)
      .sort();
  } catch {
    return '-';
  }
  return names.map((n) => `${n}@${mtimeOf(path.join(dir, n))}`).join(',');
}

/** `trackerPath` is the tracker the scripts resolve (CAREER_OPS_TRACKER may put it outside the data root); its status log sits beside it. */
/**
 * company-history.mjs reads its tracker, follow-ups, scan history and portals from its own folder (the code checkout),
 * not the data root: only its profile follows CAREER_OPS_ROOT. These are the overrides it honours, pointed at the data
 * root's files. `trackerPath` is path-resolver.mjs rawTrackerPath(dataRoot), which already puts CAREER_OPS_TRACKER
 * first; a CAREER_OPS_PORTALS in the environment wins too, so it is passed on explicitly: child-env.ts blanks an
 * inherited one, and the script would then fall back to the code checkout's portals.yml.
 */
export function companyHistoryInputs(dataRoot: string, trackerPath: string, env: NodeJS.ProcessEnv = process.env): { args: string[]; env: Record<string, string> } {
  return {
    args: ['--followups', path.join(dataRoot, 'data', 'follow-ups.md'), '--scan-history', path.join(dataRoot, 'data', 'scan-history.tsv')],
    env: { CAREER_OPS_TRACKER: trackerPath, CAREER_OPS_PORTALS: env.CAREER_OPS_PORTALS?.trim() || path.join(dataRoot, 'portals.yml') },
  };
}

export function inputsKey(dataRoot: string, trackerPath?: string): string {
  const tracker = trackerPath ? [`tracker=${trackerPath}:${mtimeOf(trackerPath)}`, `tracker-log:${mtimeOf(path.join(path.dirname(trackerPath), 'status-log.tsv'))}`] : [];
  return [...INSIGHTS_INPUT_FILES.map((rel) => `${rel}:${mtimeOf(path.join(dataRoot, rel))}`), ...INSIGHTS_INPUT_DIRS.map((rel) => `${rel}/:${dirKey(path.join(dataRoot, rel))}`), ...tracker].join('|');
}

const CODE_FILE = /\.(mjs|json)$/;

/**
 * The code a script runs: its own file, the shared modules and JSON beside it, and the shipped templates it reads
 * (states.yml, the benchmarks.yml fallback). An update changes a script's output or JSON shape without touching any data input.
 */
export function codeKey(codeRoot: string, scriptPath: string): string {
  return [`script:${mtimeOf(scriptPath)}`, `code/:${dirKey(codeRoot, CODE_FILE)}`, `code/lib/:${dirKey(path.join(codeRoot, 'lib'), CODE_FILE)}`, `code/templates/:${dirKey(path.join(codeRoot, 'templates'))}`].join('|');
}

const cachePath = (dataRoot: string, script: string) => path.join(dataRoot, 'data', 'control-center', 'insights', `${script}.json`);

export async function readInsight(cfg: ServerConfig, exec: Exec, script: InsightScript, opts: { recompute?: boolean; now?: () => number } = {}): Promise<InsightRead> {
  const def = INSIGHT_SCRIPTS[script]!;
  const tracker = await resolveTrackerFile(cfg.codeRoot, cfg.dataRoot);
  const now = opts.now ?? Date.now;
  // The scripts count days from today (rejection latency, weekly digest, funnel velocity), so a new local day is a new input.
  const extra = script === 'companyHistory' ? companyHistoryInputs(cfg.dataRoot, tracker.lexical) : { args: [], env: {} };
  // The portals file company-history reads may be a lane file outside the data root; a relative one is read from the
  // child's cwd, the code checkout.
  const portalsFile = extra.env.CAREER_OPS_PORTALS ? path.resolve(cfg.codeRoot, extra.env.CAREER_OPS_PORTALS) : null;
  const portals = portalsFile ? `|portals=${portalsFile}:${mtimeOf(portalsFile)}` : '';
  const scriptPath = cliScriptPath(cfg.codeRoot, def.cli);
  const key = `${inputsKey(cfg.dataRoot, tracker.canonical)}${portals}|${codeKey(cfg.codeRoot, scriptPath)}|day:${localDate(new Date(now()))}`;
  const file = cachePath(cfg.dataRoot, script);
  if (!opts.recompute) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as InsightRead;
      // Only a clean run is served from the cache, also when an older build cached a failure.
      if (cached.inputsKey === key && cached.kind === 'ok') return { ...cached, fromCache: true };
    } catch {
      /* no usable cache */
    }
  }
  // Loads that miss together share one run of the script for these inputs; a recompute joins it too, since a run that
  // has not finished yet is as fresh as a new one. The entry goes when the run settles, a throw included.
  const flightKey = `${file}\n${key}`;
  const inFlight = runs.get(flightKey);
  if (inFlight) return inFlight;
  const seq = (started += 1);
  const run = runInsight(cfg, exec, { script, label: def.label, scriptPath, args: extra.args, env: extra.env, key, file, now, seq }).finally(() => runs.delete(flightKey));
  runs.set(flightKey, run);
  return run;
}

const runs = new Map<string, Promise<InsightRead>>();
// Runs for one cache file with different inputs overlap when the data changes mid-run: each run is numbered when it
// starts, and a run that ends after a later-started one has written the file leaves that newer entry in place.
let started = 0;
const written = new Map<string, number>();

async function runInsight(cfg: ServerConfig, exec: Exec, job: { script: string; label: string; scriptPath: string; args: string[]; env: Record<string, string>; key: string; file: string; now: () => number; seq: number }): Promise<InsightRead> {
  const { script, scriptPath, key, file, now } = job;
  const r = await exec(process.execPath, [scriptPath, ...job.args], { cwd: cfg.codeRoot, timeoutMs: 60_000, env: { CAREER_OPS_ROOT: cfg.dataRoot, NO_COLOR: '1', ...job.env } });
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  const read: InsightRead = {
    script,
    label: job.label,
    kind: r.code === 0 ? 'ok' : 'failed',
    computedAt: new Date(now()).toISOString(),
    inputsKey: key,
    exit: r.code,
    json,
    text: r.code === 0 ? (json === null ? r.stdout : '') : `${r.stderr.trim()}\n${r.stdout.trim()}`.trim().slice(-4000),
    fromCache: false,
  };
  // A failure (a timeout or a killed child included) is often transient: caching it would serve it until the inputs or
  // the day change, so only a clean run is kept.
  // The cache only saves a rerun: a write that fails (a full disk, an unwritable directory) still returns the result.
  if (read.kind === 'ok' && (written.get(file) ?? 0) < job.seq) {
    const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(read));
      fs.renameSync(tmp, file);
      written.set(file, job.seq);
    } catch {
      // Not cached; the next load reruns the script. Removing the temp file fails too when a folder above it is a file.
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* nothing was written */
      }
    }
  }
  return read;
}

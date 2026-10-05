// Insights scripts (JSON by default, spec 1d) cached by the mtimes of their inputs.
import fs from 'node:fs';
import path from 'node:path';
import type { ServerConfig } from '../config.js';
import { cliScriptPath, importCore, type CliId } from '../core/adapter.js';
import type { Exec } from '../routes/system.js';

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

const INPUT_FILES = [
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
const INPUT_DIRS = ['reports', 'interview-prep', 'interview-prep/sessions', 'jds'];

const mtimeOf = (file: string): string => {
  try {
    return String(Math.round(fs.statSync(file).mtimeMs));
  } catch {
    return '-';
  }
};

function dirKey(dir: string): string {
  let names: string[];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch {
    return '-';
  }
  return names.map((n) => `${n}@${mtimeOf(path.join(dir, n))}`).join(',');
}

/** `trackerPath` is the tracker the scripts resolve (CAREER_OPS_TRACKER may put it outside the data root); its status log sits beside it. */
export function inputsKey(dataRoot: string, trackerPath?: string): string {
  const tracker = trackerPath ? [`tracker=${trackerPath}:${mtimeOf(trackerPath)}`, `tracker-log:${mtimeOf(path.join(path.dirname(trackerPath), 'status-log.tsv'))}`] : [];
  return [...INPUT_FILES.map((rel) => `${rel}:${mtimeOf(path.join(dataRoot, rel))}`), ...INPUT_DIRS.map((rel) => `${rel}/:${dirKey(path.join(dataRoot, rel))}`), ...tracker].join('|');
}

const cachePath = (dataRoot: string, script: string) => path.join(dataRoot, 'data', 'control-center', 'insights', `${script}.json`);

export async function readInsight(cfg: ServerConfig, exec: Exec, script: InsightScript, opts: { recompute?: boolean; now?: () => number } = {}): Promise<InsightRead> {
  const def = INSIGHT_SCRIPTS[script]!;
  const { resolveTrackerPath } = await importCore<{ resolveTrackerPath: (root: string) => string }>(cfg.codeRoot, 'path-resolver.mjs');
  const key = inputsKey(cfg.dataRoot, resolveTrackerPath(cfg.dataRoot));
  const file = cachePath(cfg.dataRoot, script);
  if (!opts.recompute) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as InsightRead;
      if (cached.inputsKey === key) return { ...cached, fromCache: true };
    } catch {
      /* no usable cache */
    }
  }
  const r = await exec(process.execPath, [cliScriptPath(cfg.codeRoot, def.cli)], { cwd: cfg.codeRoot, timeoutMs: 60_000, env: { CAREER_OPS_ROOT: cfg.dataRoot, NO_COLOR: '1' } });
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  const read: InsightRead = {
    script,
    label: def.label,
    kind: r.code === 0 ? 'ok' : 'failed',
    computedAt: new Date((opts.now ?? Date.now)()).toISOString(),
    inputsKey: key,
    exit: r.code,
    json,
    text: r.code === 0 ? (json === null ? r.stdout : '') : `${r.stderr.trim()}\n${r.stdout.trim()}`.trim().slice(-4000),
    fromCache: false,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(read));
  return read;
}

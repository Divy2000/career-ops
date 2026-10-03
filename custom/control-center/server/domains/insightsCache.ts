// Insights scripts (JSON by default, spec 1d) cached by the mtimes of their inputs.
import fs from 'node:fs';
import path from 'node:path';
import type { ServerConfig } from '../config.js';
import { cliScriptPath, type CliId } from '../core/adapter.js';
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

const INPUTS = ['data/applications.md', 'data/status-log.tsv', 'data/scan-history.tsv', 'data/pipeline.md', 'data/follow-ups.md', 'data/blacklist.md', 'reports', 'interview-prep', 'interview-prep/sessions', 'jds', 'config/profile.yml'];

export function inputsKey(dataRoot: string): string {
  return INPUTS.map((rel) => {
    try {
      return `${rel}:${Math.round(fs.statSync(path.join(dataRoot, rel)).mtimeMs)}`;
    } catch {
      return `${rel}:-`;
    }
  }).join('|');
}

const cachePath = (dataRoot: string, script: string) => path.join(dataRoot, 'data', 'control-center', 'insights', `${script}.json`);

export async function readInsight(cfg: ServerConfig, exec: Exec, script: InsightScript, opts: { recompute?: boolean; now?: () => number } = {}): Promise<InsightRead> {
  const def = INSIGHT_SCRIPTS[script]!;
  const key = inputsKey(cfg.dataRoot);
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

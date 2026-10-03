// The fork's two launchd jobs, read and written through an injectable
// executor (plutil and launchctl). Tests inject a fake; the real launchd is
// touched only by the running app on the user's request.
import fs from 'node:fs';
import path from 'node:path';
import type { Exec } from '../routes/system.js';

export interface ScheduleJob {
  label: string;
  kind: 'daily' | 'weekly';
  title: string;
  /** Script path relative to the code root; ProgramArguments must keep pointing at it. */
  script: string;
  /** Log directory relative to the data root (launchd writes there and the log browser reads there). */
  logDir: string;
  defaults: { hour: number; minute: number; weekday: number | null };
}

export const SCHEDULE_JOBS: ScheduleJob[] = [
  { label: 'com.career-ops.immigration-watch', kind: 'daily', title: 'Daily job', script: 'custom/immigration/run-daily.sh', logDir: 'data/immigration/logs', defaults: { hour: 8, minute: 0, weekday: null } },
  { label: 'com.career-ops.upstream-sync', kind: 'weekly', title: 'Weekly upstream sync', script: 'custom/upstream-sync/sync.sh', logDir: 'data/upstream-sync', defaults: { hour: 3, minute: 0, weekday: 0 } },
];

export const LOG_JOBS: Record<string, ScheduleJob> = { 'immigration-watch': SCHEDULE_JOBS[0]!, 'upstream-sync': SCHEDULE_JOBS[1]! };

export interface ScheduleState {
  label: string;
  kind: ScheduleJob['kind'];
  title: string;
  script: string;
  logDir: string;
  plistPath: string;
  plist: 'ok' | 'missing' | 'malformed';
  hour: number | null;
  minute: number | null;
  weekday: number | null;
  programArgumentsOk: boolean;
  loaded: boolean;
  /** `launchctl disable` state: launchd skips the job at login even though its plist stays in LaunchAgents. */
  disabled: boolean;
  state: string | null;
  lastExit: number | null;
  nextFire: string | null;
  error: string | null;
}

export interface ScheduleInput {
  hour: number;
  minute: number;
  weekday: number | null;
  enabled: boolean;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The script runs from the code root with CAREER_OPS_ROOT set to the data root
 * (path-resolver.mjs gives it precedence over the .career-ops-data marker), so
 * the job reads and writes the same data the app shows; its launchd logs go to
 * the data root too, where the log browser reads them.
 */
export function renderPlist(codeRoot: string, job: ScheduleJob, t: { hour: number; minute: number; weekday: number | null }, dataRoot: string): string {
  const root = esc(codeRoot);
  const logs = esc(path.join(dataRoot, job.logDir));
  const wd = t.weekday === null ? '' : `<key>Weekday</key><integer>${t.weekday}</integer>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${job.label}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>${root}/${job.script}</string></array>
  <key>WorkingDirectory</key><string>${root}</string>
  <key>EnvironmentVariables</key><dict><key>CAREER_OPS_ROOT</key><string>${esc(dataRoot)}</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${t.hour}</integer><key>Minute</key><integer>${t.minute}</integer>${wd}</dict>
  <key>StandardOutPath</key><string>${logs}/launchd.out.log</string>
  <key>StandardErrorPath</key><string>${logs}/launchd.err.log</string>
</dict>
</plist>
`;
}

/** Next local fire time for a StartCalendarInterval of hour/minute (and weekday for weekly jobs). */
export function computeNextFire(now: Date, hour: number, minute: number, weekday: number | null): Date {
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  for (let i = 0; i < 8; i += 1) {
    const matchesDay = weekday === null || candidate.getDay() === weekday;
    if (matchesDay && candidate.getTime() > now.getTime()) return candidate;
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

export function parseLaunchctlPrint(out: string): { state: string | null; lastExit: number | null } {
  const state = /^\s*state = (\S+)/m.exec(out)?.[1] ?? null;
  const exit = /last exit code = (\d+)/.exec(out);
  return { state, lastExit: exit ? Number(exit[1]) : null };
}

/** True when `launchctl print-disabled gui/<uid>` lists the label as disabled ("=> disabled", or "=> true" on older macOS). */
export function parsePrintDisabled(out: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^\\s*"${escaped}"\\s*=>\\s*(\\w+)`, 'm').exec(out);
  return m?.[1] === 'disabled' || m?.[1] === 'true';
}

interface PlistJson {
  Label?: string;
  ProgramArguments?: string[];
  StartCalendarInterval?: { Hour?: number; Minute?: number; Weekday?: number } | Array<{ Hour?: number; Minute?: number; Weekday?: number }>;
}

export class ScheduleService {
  constructor(
    private deps: { exec: Exec; agentsDir: string; uid: number; codeRoot: string; dataRoot: string; now?: () => Date },
  ) {}

  job(label: string): ScheduleJob | undefined {
    return SCHEDULE_JOBS.find((j) => j.label === label);
  }

  plistPath(job: ScheduleJob): string {
    return path.join(this.deps.agentsDir, `${job.label}.plist`);
  }

  async readAll(): Promise<ScheduleState[]> {
    const out: ScheduleState[] = [];
    for (const job of SCHEDULE_JOBS) out.push(await this.readOne(job));
    return out;
  }

  async readOne(job: ScheduleJob): Promise<ScheduleState> {
    const plistPath = this.plistPath(job);
    const base: ScheduleState = { label: job.label, kind: job.kind, title: job.title, script: job.script, logDir: job.logDir, plistPath, plist: 'missing', hour: null, minute: null, weekday: null, programArgumentsOk: false, loaded: false, disabled: false, state: null, lastExit: null, nextFire: null, error: null };
    if (fs.existsSync(plistPath)) {
      const r = await this.deps.exec('plutil', ['-convert', 'json', '-o', '-', plistPath], { timeoutMs: 10_000 });
      if (r.code !== 0) {
        base.plist = 'malformed';
        base.error = r.stderr.trim() || `plutil exit ${r.code}`;
      } else {
        try {
          const json = JSON.parse(r.stdout) as PlistJson;
          const sci = Array.isArray(json.StartCalendarInterval) ? json.StartCalendarInterval[0] : json.StartCalendarInterval;
          base.plist = 'ok';
          base.hour = typeof sci?.Hour === 'number' ? sci.Hour : null;
          base.minute = typeof sci?.Minute === 'number' ? sci.Minute : null;
          base.weekday = typeof sci?.Weekday === 'number' ? sci.Weekday : null;
          const args = json.ProgramArguments ?? [];
          base.programArgumentsOk = args.some((a) => a === path.join(this.deps.codeRoot, job.script) || a.endsWith(`/${job.script}`));
        } catch (err) {
          base.plist = 'malformed';
          base.error = `plutil printed non-JSON: ${(err as Error).message}`;
        }
      }
    }
    const print = await this.deps.exec('launchctl', ['print', `gui/${this.deps.uid}/${job.label}`], { timeoutMs: 10_000 });
    base.loaded = print.code === 0;
    if (print.code === 0) {
      const parsed = parseLaunchctlPrint(print.stdout);
      base.state = parsed.state;
      base.lastExit = parsed.lastExit;
    }
    const disabled = await this.deps.exec('launchctl', ['print-disabled', `gui/${this.deps.uid}`], { timeoutMs: 10_000 });
    base.disabled = disabled.code === 0 && parsePrintDisabled(disabled.stdout, job.label);
    if (base.loaded && base.hour !== null && base.minute !== null) {
      base.nextFire = computeNextFire((this.deps.now ?? (() => new Date()))(), base.hour, base.minute, base.weekday).toISOString();
    }
    return base;
  }

  /**
   * Writes the plist and lints it. Enabling runs launchctl enable, bootout and
   * bootstrap; disabling runs launchctl disable (persistent: launchd would
   * otherwise load the plist again at the next login) and bootout.
   */
  async write(job: ScheduleJob, input: ScheduleInput): Promise<{ ok: true; state: ScheduleState } | { ok: false; status: number; error: string; stderr: string }> {
    const plistPath = this.plistPath(job);
    fs.mkdirSync(this.deps.agentsDir, { recursive: true });
    const tmp = `${plistPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, renderPlist(this.deps.codeRoot, job, input, this.deps.dataRoot));
    // launchd does not create the log directory; without it the job's output is lost.
    fs.mkdirSync(path.join(this.deps.dataRoot, job.logDir), { recursive: true });
    fs.renameSync(tmp, plistPath);
    const lint = await this.deps.exec('plutil', ['-lint', plistPath], { timeoutMs: 10_000 });
    if (lint.code !== 0) return { ok: false, status: 500, error: `plutil -lint rejected the plist (exit ${lint.code})`, stderr: lint.stderr.trim() };
    const target = `gui/${this.deps.uid}/${job.label}`;
    if (input.enabled) {
      const enable = await this.deps.exec('launchctl', ['enable', target], { timeoutMs: 20_000 });
      if (enable.code !== 0) return { ok: false, status: 502, error: `launchctl enable failed (exit ${enable.code})`, stderr: enable.stderr.trim() };
    } else {
      const disable = await this.deps.exec('launchctl', ['disable', target], { timeoutMs: 20_000 });
      if (disable.code !== 0) return { ok: false, status: 502, error: `launchctl disable failed (exit ${disable.code}); the job would load again at the next login`, stderr: disable.stderr.trim() };
    }
    // bootout fails when the job is not loaded; that is the expected state before the first install.
    await this.deps.exec('launchctl', ['bootout', target], { timeoutMs: 20_000 });
    if (input.enabled) {
      const boot = await this.deps.exec('launchctl', ['bootstrap', `gui/${this.deps.uid}`, plistPath], { timeoutMs: 20_000 });
      if (boot.code !== 0) return { ok: false, status: 502, error: `launchctl bootstrap failed (exit ${boot.code})`, stderr: boot.stderr.trim() };
    }
    return { ok: true, state: await this.readOne(job) };
  }
}

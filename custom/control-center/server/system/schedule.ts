// The fork's two launchd jobs, read and written through an injectable
// executor (plutil and launchctl). Tests inject a fake; the real launchd is
// touched only by the running app on the user's request.
import fs from 'node:fs';
import path from 'node:path';
import type { Exec } from '../routes/system.js';
import { isLockTimeout, withFileLock } from '../lib/file-lock.js';

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
  lastSignal: string | null;
  runs: number | null;
  nextFire: string | null;
  error: string | null;
}

export interface ScheduleInput {
  hour: number;
  minute: number;
  weekday: number | null;
  enabled: boolean;
}

/**
 * The node the jobs are pinned to (CC_NODE_BIN, which custom/launchd/pinned-node.sh puts first on the job's PATH), by
 * the rule custom/launchd/install.sh uses: the first node on PATH (what `command -v node` finds) as written, such as
 * /opt/homebrew/bin/node, which outlives an upgrade where the versioned binary it links to does not. It is the real
 * binary (process.execPath) when that entry is relative, is an fnm per-shell link (fnm_multishells, gone with its
 * shell), or does not resolve to the node that runs (a shim, another install).
 */
export function pinnedNodeBin(execPath: string = process.execPath, pathEnv: string = process.env.PATH ?? ''): string {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  };
  const self = real(execPath) ?? execPath;
  const found = pathEnv
    .split(path.delimiter)
    .map((dir) => path.join(dir || '.', 'node'))
    .find((candidate) => {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
  const keep = found !== undefined && path.isAbsolute(found) && !found.includes('fnm_multishells') && real(found) === self;
  return keep ? found : self;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The script runs from the code root with CAREER_OPS_ROOT set to the data root
 * (path-resolver.mjs gives it precedence over the .career-ops-data marker), so
 * the job reads and writes the same data the app shows; its launchd logs go to
 * the data root too, where the log browser reads them. The daily job also gets
 * CC_CLAUDE_BIN, the absolute claude the app runs: launchd's own PATH could
 * otherwise reach another install (an old one in /usr/local/bin, say) first. Both jobs get CC_NODE_BIN, the node the
 * app runs on: launchd's PATH has no nvm, fnm, volta or asdf node.
 */
export function renderPlist(codeRoot: string, job: ScheduleJob, t: { hour: number; minute: number; weekday: number | null }, dataRoot: string, opts: { pinDataRoot?: boolean; claudeBin?: string; nodeBin?: string } = {}): string {
  const root = esc(codeRoot);
  const logs = esc(path.join(dataRoot, job.logDir));
  const wd = t.weekday === null ? '' : `<key>Weekday</key><integer>${t.weekday}</integer>`;
  const vars = [
    ...(opts.pinDataRoot === false ? [] : [`<key>CAREER_OPS_ROOT</key><string>${esc(dataRoot)}</string>`]),
    ...(job.kind === 'daily' && opts.claudeBin && path.isAbsolute(opts.claudeBin) ? [`<key>CC_CLAUDE_BIN</key><string>${esc(opts.claudeBin)}</string>`] : []),
    ...(opts.nodeBin && path.isAbsolute(opts.nodeBin) ? [`<key>CC_NODE_BIN</key><string>${esc(opts.nodeBin)}</string>`] : []),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${job.label}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>${root}/${job.script}</string></array>
  <key>WorkingDirectory</key><string>${root}</string>
  ${vars.length ? `<key>EnvironmentVariables</key><dict>${vars.join('')}</dict>` : ''}
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
  // launchd reads Weekday 7 as Sunday; getDay() never returns 7.
  const day = weekday === null ? null : weekday % 7;
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  for (let i = 0; i < 8; i += 1) {
    const matchesDay = day === null || candidate.getDay() === day;
    if (matchesDay && candidate.getTime() > now.getTime()) return candidate;
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

export function parseLaunchctlPrint(out: string): { state: string | null; lastExit: number | null; lastSignal: string | null; runs: number | null } {
  // The state is the rest of the line: "not running" means loaded and idle, which is the normal state between calendar fires.
  const state = /^\s*state = (.+?)\s*$/m.exec(out)?.[1] ?? null;
  const exit = /last exit code = (-?\d+)/.exec(out);
  // A job that launchd killed reports a signal and no exit code.
  const lastSignal = /^\s*last terminating signal = (.+?)\s*$/m.exec(out)?.[1] ?? null;
  const runs = /^\s*runs = (\d+)/m.exec(out)?.[1];
  return { state, lastExit: exit ? Number(exit[1]) : null, lastSignal, runs: runs === undefined ? null : Number(runs) };
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

/** launchctl print's exit status for a service launchd does not have loaded ("Could not find service"). */
const LAUNCHCTL_NO_SUCH_SERVICE = 113;
// One save per plist at a time, across every server process (the two children of a blue/green handover included): two
// saves at once (a double click, Save then Disable, one save in each child) would otherwise share the temp plist and
// interleave their launchctl steps, and one's restore would put its stale plist over the other's. A waiter outlasts
// one save's launchctl steps.
const WRITE_LOCK_TIMEOUT_MS = 30_000;

export type ScheduleWriteResult = { ok: true; state: ScheduleState } | { ok: false; status: number; error: string; stderr: string };

export class ScheduleService {
  constructor(
    private deps: { exec: Exec; agentsDir: string; uid: number; codeRoot: string; dataRoot: string; dataRootFromEnv?: boolean; claudeBin?: string; nodeBin?: string; now?: () => Date },
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
    const base: ScheduleState = { label: job.label, kind: job.kind, title: job.title, script: job.script, logDir: job.logDir, plistPath, plist: 'missing', hour: null, minute: null, weekday: null, programArgumentsOk: false, loaded: false, disabled: false, state: null, lastExit: null, lastSignal: null, runs: null, nextFire: null, error: null };
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
      base.lastSignal = parsed.lastSignal;
      base.runs = parsed.runs;
    }
    const disabled = await this.deps.exec('launchctl', ['print-disabled', `gui/${this.deps.uid}`], { timeoutMs: 10_000 });
    base.disabled = disabled.code === 0 && parsePrintDisabled(disabled.stdout, job.label);
    if (base.loaded && base.hour !== null && base.minute !== null) {
      base.nextFire = computeNextFire((this.deps.now ?? (() => new Date()))(), base.hour, base.minute, base.weekday).toISOString();
    }
    return base;
  }

  /**
   * Writes the plist, lints it, and installs it once the lint passes. Enabling runs launchctl enable, bootout and
   * bootstrap; disabling runs launchctl disable (persistent: launchd would
   * otherwise load the plist again at the next login) and bootout.
   */
  write(job: ScheduleJob, input: ScheduleInput): Promise<ScheduleWriteResult> {
    return withFileLock(this.deps.codeRoot, this.plistPath(job), () => this.writeLocked(job, input), { timeoutMs: WRITE_LOCK_TIMEOUT_MS }).catch((err: unknown) => {
      if (!isLockTimeout(err)) throw err;
      return { ok: false as const, status: 409, error: `another save of the ${job.title} schedule is still running; try again in a moment`, stderr: '' };
    });
  }

  private async writeLocked(job: ScheduleJob, input: ScheduleInput): Promise<ScheduleWriteResult> {
    const plistPath = this.plistPath(job);
    // Every save boots the job out, and bootout of a LaunchAgent launchd is running stops that run mid-step (a half-done
    // policy pass, an unacked queue, a half-installed node_modules). Only launchd's own instance is at risk: a run
    // started from the app or a terminal is not its child.
    const print = await this.deps.exec('launchctl', ['print', `gui/${this.deps.uid}/${job.label}`], { timeoutMs: 10_000 });
    if (print.code === 0 && parseLaunchctlPrint(print.stdout).state === 'running') {
      return { ok: false, status: 409, error: `${job.title} is running now, and changing its schedule would stop it. Try again once it finishes.`, stderr: '' };
    }
    const target = `gui/${this.deps.uid}/${job.label}`;
    // What a failed save puts back: the installed plist, whether launchd had the job loaded, and whether it was disabled.
    const wasLoaded = print.code === 0;
    const disabledBefore = await this.deps.exec('launchctl', ['print-disabled', `gui/${this.deps.uid}`], { timeoutMs: 10_000 });
    const disabledKnown = disabledBefore.code === 0;
    const wasDisabled = disabledKnown && parsePrintDisabled(disabledBefore.stdout, job.label);
    let previous: Buffer | null = null;
    try {
      previous = fs.readFileSync(plistPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    fs.mkdirSync(this.deps.agentsDir, { recursive: true });
    const tmp = `${plistPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, renderPlist(this.deps.codeRoot, job, input, this.deps.dataRoot, { pinDataRoot: this.deps.dataRootFromEnv, claudeBin: this.deps.claudeBin, nodeBin: this.deps.nodeBin }));
    // Linted beside the installed plist and moved over it only once it passes: launchd loads whatever is in
    // LaunchAgents at login, so a plist that fails the lint must never replace a working one. The temp name does not
    // end in .plist, so launchd never loads it.
    const lint = await this.deps.exec('plutil', ['-lint', tmp], { timeoutMs: 10_000 });
    if (lint.code !== 0) {
      fs.rmSync(tmp, { force: true });
      return { ok: false, status: 500, error: `plutil -lint rejected the plist (exit ${lint.code}); the installed one is unchanged`, stderr: lint.stderr.trim() };
    }
    // launchd does not create the log directory; without it the job's output is lost.
    fs.mkdirSync(path.join(this.deps.dataRoot, job.logDir), { recursive: true });
    fs.renameSync(tmp, plistPath);
    let enabledNow = false;
    let disabledNow = false;
    let bootstrapped = false;
    const failed = async (error: string, stderr: string): Promise<ScheduleWriteResult> => {
      // A flag this save changed without knowing its prior value cannot be put back, so the restore does not claim it was.
      const flagUnknown = (enabledNow || disabledNow) && !disabledKnown;
      const disabledAfterSave = disabledNow || (!enabledNow && wasDisabled);
      const restored = (await this.restore({ plistPath, target, previous, wasLoaded, bootstrapped, disabledAfterSave, disabledBefore: disabledKnown ? wasDisabled : disabledAfterSave })) && !flagUnknown;
      return { ok: false, status: 502, error: `${error}; ${restored ? 'the previous schedule was restored' : 'restoring the previous schedule also failed'}`, stderr };
    };
    if (input.enabled) {
      const enable = await this.deps.exec('launchctl', ['enable', target], { timeoutMs: 20_000 });
      if (enable.code !== 0) return failed(`launchctl enable failed (exit ${enable.code})`, enable.stderr.trim());
      enabledNow = true;
    } else {
      const disable = await this.deps.exec('launchctl', ['disable', target], { timeoutMs: 20_000 });
      if (disable.code !== 0) return failed(`launchctl disable failed (exit ${disable.code}); the job would load again at the next login`, disable.stderr.trim());
      disabledNow = true;
    }
    // bootout fails when the job is not loaded; that is the expected state before the first install. So a failed bootout
    // is fine only if print now says the job is gone (no such service): one still loaded, or whose state print could not
    // read, may keep firing on its old schedule, so that is a failed save.
    const bootout = await this.deps.exec('launchctl', ['bootout', target], { timeoutMs: 20_000 });
    if (bootout.code !== 0 && (await this.deps.exec('launchctl', ['print', target], { timeoutMs: 10_000 })).code !== LAUNCHCTL_NO_SUCH_SERVICE) {
      return failed(`launchctl bootout failed (exit ${bootout.code}) and the job may still be loaded`, bootout.stderr.trim());
    }
    if (input.enabled) {
      bootstrapped = true;
      const boot = await this.deps.exec('launchctl', ['bootstrap', `gui/${this.deps.uid}`, plistPath], { timeoutMs: 20_000 });
      if (boot.code !== 0) return failed(`launchctl bootstrap failed (exit ${boot.code})`, boot.stderr.trim());
    }
    return { ok: true, state: await this.readOne(job) };
  }

  /**
   * Puts back what a save changed before a launchctl step failed: the previous plist (or none), the loaded job the save
   * booted out or the job it loaded, and the disabled flag the save cleared or set. Answers whether every step worked.
   */
  private async restore(s: { plistPath: string; target: string; previous: Buffer | null; wasLoaded: boolean; bootstrapped: boolean; disabledAfterSave: boolean; disabledBefore: boolean }): Promise<boolean> {
    if (s.previous === null) fs.rmSync(s.plistPath, { force: true });
    else {
      const tmp = `${s.plistPath}.restore-${process.pid}`;
      fs.writeFileSync(tmp, s.previous);
      fs.renameSync(tmp, s.plistPath);
    }
    let ok = true;
    let disabled = s.disabledAfterSave;
    const setDisabled = async (want: boolean) => {
      if (disabled === want) return;
      ok = (await this.deps.exec('launchctl', [want ? 'disable' : 'enable', s.target], { timeoutMs: 20_000 })).code === 0 && ok;
      disabled = want;
    };
    const loaded = (await this.deps.exec('launchctl', ['print', s.target], { timeoutMs: 10_000 })).code === 0;
    if (s.wasLoaded && !loaded && s.previous !== null) {
      // launchd refuses to bootstrap a disabled job, so the flag is cleared first; a job that was loaded while disabled
      // gets its flag back below.
      await setDisabled(false);
      ok = (await this.deps.exec('launchctl', ['bootstrap', `gui/${this.deps.uid}`, s.plistPath], { timeoutMs: 20_000 })).code === 0 && ok;
    } else if (!s.wasLoaded && loaded && s.bootstrapped) {
      // Only a job this save loaded is booted out; one another client loaded meanwhile is not this save's to undo.
      ok = (await this.deps.exec('launchctl', ['bootout', s.target], { timeoutMs: 20_000 })).code === 0 && ok;
    }
    await setDisabled(s.disabledBefore);
    return ok;
  }
}

import fs from 'node:fs';
import path from 'node:path';
import type { EventBus } from '../watch/bus.js';
import type { Exec } from '../routes/system.js';
import type { ServerConfig } from '../config.js';

export interface DailyStatus {
  running: boolean;
  checkedAt: string | null;
}

/** Answers whether the daily job runs now. */
export type DailyProbe = () => Promise<boolean>;

/** Test builds only: answer the probe from the override so a real daily job on the host never leaks into a run. */
export function maybeFakeDailyProbe(cfg: ServerConfig, probe: DailyProbe): DailyProbe {
  if (!cfg.fakeDaily || cfg.nodeEnv !== 'test') return probe;
  const running = cfg.fakeDaily === 'running';
  return async () => running;
}

/** run-daily.sh writes its pid here once it holds the job lock, and removes it when it exits. */
export const dailyPidfile = (dataRoot: string) => path.join(dataRoot, 'data', 'immigration', '.run-daily.pid');

/**
 * The job's own command line: bash running run-daily.sh as its script, by any path (launchd and the app pass an
 * absolute one; a manual run types `bash custom/immigration/run-daily.sh` or `bash run-daily.sh`, which the lock
 * re-exec keeps). Anchored, so a Claude prompt or a `bash -c` that merely names the script is not the job.
 */
export const DAILY_JOB_PATTERN = '^([^ ]*/)?bash ([^-].*/)?run-daily\\.sh( |$)';
const DAILY_JOB_RE = new RegExp(DAILY_JOB_PATTERN);

/**
 * The job runs when the pid in this data root's pidfile is alive and is bash running run-daily.sh. Only the lock
 * holder writes the file, so it names this data root's run however the script was started, and never another
 * project's run-daily.sh; the command line check keeps a stale file whose pid was reused from counting. Probing the
 * lock with lockf instead could make a scheduled run skip.
 */
export function dailyPidfileProbe(dataRoot: string, exec: Exec): DailyProbe {
  return async () => {
    let pid: string;
    try {
      pid = fs.readFileSync(dailyPidfile(dataRoot), 'utf8').trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
    if (!/^[1-9]\d*$/.test(pid)) return false;
    const r = await exec('ps', ['-o', 'command=', '-p', pid], { timeoutMs: 4000 });
    return r.code === 0 && DAILY_JOB_RE.test(r.stdout.trim());
  };
}

/** Polls the probe; never blocks anything (core locks do). */
export class DailyJobWatch {
  private timer: NodeJS.Timeout | null = null;
  private state: DailyStatus = { running: false, checkedAt: null };

  constructor(
    private probe: DailyProbe,
    private bus: EventBus,
    private intervalMs = 10_000,
  ) {}

  start(): void {
    // A pidfile that cannot be read (not one that is missing) is reported, and the next poll asks again.
    const tick = () => void this.poll().catch((err: Error) => console.error(`[daily] probe failed: ${err.message}`));
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): DailyStatus {
    return this.state;
  }

  /** Probes now instead of trusting the last poll (up to intervalMs old): a run just started from the app must not read as interrupted. */
  async runningNow(): Promise<boolean> {
    await this.poll();
    return this.state.running;
  }

  async poll(): Promise<void> {
    const running = await this.probe();
    const changed = running !== this.state.running;
    this.state = { running, checkedAt: new Date().toISOString() };
    if (changed) this.bus.publish('daily.status', { running });
  }
}

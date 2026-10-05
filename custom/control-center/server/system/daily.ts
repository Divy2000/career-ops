import type { EventBus } from '../watch/bus.js';
import type { Exec } from '../routes/system.js';
import type { ServerConfig } from '../config.js';

export interface DailyStatus {
  running: boolean;
  checkedAt: string | null;
}

/** Test builds only: answer the run-daily.sh probe from the override so a real daily job on the host never leaks into a run. */
export function maybeFakeDailyProbe(cfg: ServerConfig, exec: Exec): Exec {
  if (!cfg.fakeDaily || cfg.nodeEnv !== 'test') return exec;
  const running = cfg.fakeDaily === 'running';
  return async (cmd, args, opts) => (cmd === 'pgrep' ? { code: running ? 0 : 1, stdout: running ? '4242\n' : '', stderr: '' } : exec(cmd, args, opts));
}

/**
 * The job's own command line: bash running run-daily.sh as its script, by any path (launchd and the app pass an
 * absolute one; a manual run types `bash custom/immigration/run-daily.sh` or `bash run-daily.sh`, which the lock
 * re-exec keeps). Anchored, because pgrep -f matches the whole argument list and a Claude prompt or a `bash -c` that
 * merely names the script must not read as the job running. Probing the lock with lockf instead could make a
 * scheduled run skip.
 */
export const DAILY_JOB_PATTERN = '^([^ ]*/)?bash ([^-].*/)?run-daily\\.sh( |$)';

/** Polls `pgrep -f DAILY_JOB_PATTERN`; never blocks anything (core locks do). */
export class DailyJobWatch {
  private timer: NodeJS.Timeout | null = null;
  private state: DailyStatus = { running: false, checkedAt: null };

  constructor(
    private exec: Exec,
    private bus: EventBus,
    private intervalMs = 10_000,
  ) {}

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
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
    const r = await this.exec('pgrep', ['-f', DAILY_JOB_PATTERN], { timeoutMs: 4000 });
    const running = r.code === 0 && r.stdout.trim().length > 0;
    const changed = running !== this.state.running;
    this.state = { running, checkedAt: new Date().toISOString() };
    if (changed) this.bus.publish('daily.status', { running });
  }
}

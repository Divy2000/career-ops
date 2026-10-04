import type { EventBus } from '../watch/bus.js';
import type { Exec } from '../routes/system.js';
import type { ServerConfig } from '../config.js';

export interface DailyStatus {
  running: boolean;
  checkedAt: string | null;
}

/** Test builds only: answer the run-daily.sh probe from the override so a real daily job on the host never leaks into a run. */
export function maybeFakeDailyProbe(cfg: ServerConfig, exec: Exec): Exec {
  if (!cfg.fakeDaily) return exec;
  const running = cfg.fakeDaily === 'running';
  return async (cmd, args, opts) => (cmd === 'pgrep' ? { code: running ? 0 : 1, stdout: running ? '4242\n' : '', stderr: '' } : exec(cmd, args, opts));
}

/** Polls `pgrep -f custom/immigration/run-daily.sh`; never blocks anything (core locks do). */
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

  async poll(): Promise<void> {
    const r = await this.exec('pgrep', ['-f', 'custom/immigration/run-daily.sh'], { timeoutMs: 4000 });
    const running = r.code === 0 && r.stdout.trim().length > 0;
    const changed = running !== this.state.running;
    this.state = { running, checkedAt: new Date().toISOString() };
    if (changed) this.bus.publish('daily.status', { running });
  }
}

import type { EventBus } from '../watch/bus.js';
import type { Exec } from '../routes/system.js';

export interface DailyStatus {
  running: boolean;
  checkedAt: string | null;
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

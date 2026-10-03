const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD HH:mm` in the viewer's local time for an ISO instant; the input is returned unchanged when it is not a date. */
export function formatLocalMinute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** What the "Last exit" row of a launchd job says; "never ran" only when launchd reports no runs or no exit at all. */
export function describeLastExit(job: { lastExit: number | null; lastSignal: string | null; runs: number | null }): string {
  if (job.lastSignal) return `killed by signal (${job.lastSignal})`;
  if (job.lastExit !== null) return String(job.lastExit);
  if (job.runs !== null && job.runs > 0) return `unknown (ran ${job.runs} times)`;
  return 'never ran';
}

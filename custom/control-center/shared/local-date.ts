// The one "what day is it here" helper for the server and the web client. The job scripts date their logs with
// `date +%Y-%m-%d`, scan.mjs stamps first-seen dates and follow-ups are logged by the local day, so "today" is the
// local calendar date: `toISOString().slice(0, 10)` is already tomorrow on a US evening.
const pad = (n: number) => String(n).padStart(2, '0');

/** The local calendar date (YYYY-MM-DD) of an instant, now by default. */
export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The local date `days` calendar days after `from` (whole days, so a DST change does not shift it). */
export function localDatePlusDays(days: number, from = new Date()): string {
  return localDate(new Date(from.getFullYear(), from.getMonth(), from.getDate() + days));
}

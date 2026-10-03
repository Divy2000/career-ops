const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD HH:mm` in the viewer's local time for an ISO instant; the input is returned unchanged when it is not a date. */
export function formatLocalMinute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

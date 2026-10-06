const COUNT = new Intl.NumberFormat('en-US');

/** A whole count with thousands separators ("66,934"), fixed to en-US so the page reads the same on every machine. */
export function formatCount(n: number): string {
  return COUNT.format(n);
}

/** A conversion rate as a percentage; null (no denominator yet) reads "n/a", never "n/a%". */
export function formatRate(rate: number | null): string {
  return rate === null ? 'n/a' : `${rate}%`;
}

/** A discard reason as the report writer emits it (salary_too_low) in words (salary too low). */
export function reasonLabel(reason: string): string {
  return reason.replace(/_+/g, ' ').trim();
}

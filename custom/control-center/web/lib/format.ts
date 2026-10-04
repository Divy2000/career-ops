const COUNT = new Intl.NumberFormat('en-US');

/** A whole count with thousands separators ("66,934"), fixed to en-US so the page reads the same on every machine. */
export function formatCount(n: number): string {
  return COUNT.format(n);
}

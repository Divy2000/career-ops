import { localDate } from '../../shared/local-date.js';
import type { ScanHistoryRow } from './pipeline.js';

export type NormalizeTextKey = (value: unknown, separator?: string) => string;

export interface FreshOffer {
  url: string;
  company: string;
  title: string;
  location: string;
  postedAt: string;
  firstSeen: string;
  ats: string;
}

/** Company AND role key: suppressing by employer alone hid whole boards (alpha #3131). */
export function suppressionKey(norm: NormalizeTextKey, company: string, role: string): string {
  return `${norm(company, ' ')}|${norm(role, ' ')}`;
}

export function evaluatedKeys(applications: Array<{ company: string; role: string }>, norm: NormalizeTextKey): Set<string> {
  const keys = new Set<string>();
  for (const app of applications) {
    if (!norm(app.company, ' ')) continue;
    keys.add(suppressionKey(norm, app.company, app.role));
  }
  return keys;
}

export function isEvaluated(keys: Set<string>, norm: NormalizeTextKey, company: string, title: string): boolean {
  if (!company || !norm(company, ' ')) return false;
  return keys.has(suppressionKey(norm, company, title));
}

export const MAX_OFFER_LIMIT = 200;

export function resolveOfferLimit(raw: unknown, fallback = 12): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(MAX_OFFER_LIMIT, n);
}

export function collectWhatsNew(opts: {
  history: ScanHistoryRow[];
  applications: Array<{ company: string; role: string }>;
  norm: NormalizeTextKey;
  now: number;
  days: number;
  limit: number;
}): { offers: FreshOffer[]; count: number } {
  const days = Math.min(30, Math.max(1, opts.days));
  // scan.mjs writes first_seen as a local date, so the window is N local calendar days ending today, not N x 24h back
  // from now (which kept 6, 7 or 8 days depending on the hour and the time zone).
  const today = new Date(opts.now);
  const earliest = localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1)));
  const keys = evaluatedKeys(opts.applications, opts.norm);
  const offers: FreshOffer[] = [];
  let count = 0;
  const sorted = [...opts.history].sort((a, b) => (a.firstSeen < b.firstSeen ? 1 : a.firstSeen > b.firstSeen ? -1 : 0));
  for (const row of sorted) {
    if (!/^https?:\/\//i.test(row.url)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.firstSeen) || row.firstSeen < earliest) continue;
    // Only what the scanner put in the pipeline: it also records skips, expiries and company cooldowns (`cooldown:...`).
    if (row.status.trim().toLowerCase() !== 'added') continue;
    if (isEvaluated(keys, opts.norm, row.company, row.title)) continue;
    count++;
    if (offers.length < opts.limit) {
      offers.push({
        url: row.url,
        company: row.company.trim(),
        title: row.title.trim(),
        location: row.location.trim(),
        postedAt: /^\d{4}-\d{2}-\d{2}$/.test(row.postedAt) ? row.postedAt : '',
        firstSeen: row.firstSeen,
        ats: row.portal.replace(/-full$/, '').trim() || 'other',
      });
    }
  }
  return { offers, count };
}

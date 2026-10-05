export interface FollowupEntry {
  num: number;
  appNum: number;
  date: string;
  company: string;
  role: string;
  channel: string;
  contact: string;
  notes: string;
}

/** Table rows of data/follow-ups.md (`| num | appNum | date | company | role | channel | contact | notes |`). */
export function parseFollowupsTable(text: string): FollowupEntry[] {
  const out: FollowupEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length < 8) continue;
    const num = parseInt(parts[1]!, 10);
    const appNum = parseInt(parts[2]!, 10);
    if (Number.isNaN(num) || Number.isNaN(appNum)) continue;
    out.push({
      num,
      appNum,
      date: parts[3] ?? '',
      company: parts[4] ?? '',
      role: parts[5] ?? '',
      channel: parts[6] ?? '',
      contact: parts[7] ?? '',
      notes: parts[8] ?? '',
    });
  }
  return out;
}

export interface NextOverride {
  appNum: number;
  date: string;
  setOn: string;
}

/** The pin the cadence still honors (followup-cadence.mjs resolveNextOverride): a follow-up logged after the day it was set drops it. */
export function activePin(pin: NextOverride | null, followups: Array<{ date: string }>): NextOverride | null {
  if (!pin) return null;
  const last = followups.reduce<string | null>((max, f) => (max === null || f.date > max ? f.date : max), null);
  return last !== null && last > pin.setOn ? null : pin;
}

const OVERRIDE_RE = /^-\s+next\s+#(\d+)\s+(\d{4}-\d{2}-\d{2})(?:\s+\(set\s+(\d{4}-\d{2}-\d{2})\))?/i;

/** Pin directives (`- next #42 2026-07-10 (set 2026-07-02)`); the last one per application wins. */
export function parseNextOverrides(text: string): Map<number, NextOverride> {
  const out = new Map<number, NextOverride>();
  for (const line of text.split('\n')) {
    const m = line.match(OVERRIDE_RE);
    if (!m) continue;
    const appNum = parseInt(m[1]!, 10);
    out.set(appNum, { appNum, date: m[2]!, setOn: m[3] ?? m[2]! });
  }
  return out;
}

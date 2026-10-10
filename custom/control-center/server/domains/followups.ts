export interface FollowupEntry {
  /** null for a legacy bullet line, which has no row number. */
  num: number | null;
  appNum: number;
  date: string;
  company: string;
  role: string;
  channel: string;
  contact: string;
  notes: string;
}

// followup-cadence.mjs BULLET_RE: legacy bullets early web builds wrote, `- YYYY-MM-DD \u00b7 #NUM Company <em dash> note`.
const BULLET_RE = new RegExp(`^-\\s+(\\d{4}-\\d{2}-\\d{2})\\s+\u00b7\\s+#(\\d+)\\s+(.+?)(?:\\s+${String.fromCharCode(0x2014)}\\s+(.*))?$`);

/**
 * The follow-ups logged in data/follow-ups.md, read exactly as followup-cadence.mjs parseFollowups reads them:
 * table rows (`| num | appNum | date | company | role | channel | contact | notes |`) and legacy bullets.
 */
export function parseFollowups(text: string): FollowupEntry[] {
  const out: FollowupEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('|')) {
      const parts = line.split('|').map((s) => s.trim());
      if (parts.length < 8) continue;
      const num = parseInt(parts[1]!, 10);
      if (Number.isNaN(num)) continue;
      const appNum = parseInt(parts[2]!, 10);
      if (Number.isNaN(appNum)) continue;
      out.push({ num, appNum, date: parts[3]!, company: parts[4]!, role: parts[5]!, channel: parts[6]!, contact: parts[7]!, notes: parts[8] || '' });
      continue;
    }
    const m = line.match(BULLET_RE);
    if (!m) continue;
    out.push({ num: null, appNum: parseInt(m[2]!, 10), date: m[1]!, company: m[3]!, role: '', channel: 'Other', contact: '', notes: m[4] || '' });
  }
  return out;
}

export interface NextOverride {
  appNum: number;
  date: string;
  setOn: string;
  /** The day of the application's last `- cleared #N` retirement, when the file has one. */
  clearedOn?: string;
}

/**
 * The pin the cadence still honors (followup-cadence.mjs resolveNextOverride and isRetired): a follow-up logged after
 * the day it was set drops it, and a retirement outranks it until a follow-up logged after the retirement day.
 */
export function activePin(pin: NextOverride | null, followups: Array<{ date: string }>): NextOverride | null {
  if (!pin) return null;
  const last = followups.reduce<string | null>((max, f) => (max === null || f.date > max ? f.date : max), null);
  if (pin.clearedOn !== undefined && !(last !== null && last > pin.clearedOn)) return null;
  return last !== null && last > pin.setOn ? null : pin;
}

// followup-cadence.mjs CLEARED_RE: `- cleared #N YYYY-MM-DD`, with the same optional trailing reason.
const CLEARED_RE = new RegExp(`^-\\s+cleared\\s+#(\\d+)\\s+(\\d{4}-\\d{2}-\\d{2})(?:\\s*[${String.fromCharCode(0x2014)}\u2013-].*)?\\s*$`, 'i');

// followup-cadence.mjs OVERRIDE_RE: an optional trailing `<dash> reason` (em dash, en dash or hyphen) and nothing else.
const OVERRIDE_RE = new RegExp(`^-\\s+next\\s+#(\\d+)\\s+(\\d{4}-\\d{2}-\\d{2})(?:\\s+\\(set\\s+(\\d{4}-\\d{2}-\\d{2})\\))?(?:\\s*[${String.fromCharCode(0x2014)}\u2013-].*)?\\s*$`, 'i');

/** followup-cadence.mjs parseDate: a real calendar day, so 2026-02-31 is no date. */
function isCalendarDate(s: string): boolean {
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Pin directives (`- next #42 2026-07-10 (set 2026-07-02)`); the last one per application wins. A pinned application's
 * last retirement directive (followup-cadence.mjs parseClearedDirectives) rides along as clearedOn.
 */
export function parseNextOverrides(text: string): Map<number, NextOverride> {
  const out = new Map<number, NextOverride>();
  const cleared = new Map<number, string>();
  for (const line of text.split('\n')) {
    const c = line.match(CLEARED_RE);
    if (c) {
      if (isCalendarDate(c[2]!)) cleared.set(parseInt(c[1]!, 10), c[2]!);
      continue;
    }
    const m = line.match(OVERRIDE_RE);
    if (!m || !isCalendarDate(m[2]!)) continue;
    const appNum = parseInt(m[1]!, 10);
    out.set(appNum, { appNum, date: m[2]!, setOn: m[3] || m[2]! });
  }
  for (const [appNum, pin] of out) {
    const clearedOn = cleared.get(appNum);
    if (clearedOn !== undefined) pin.clearedOn = clearedOn;
  }
  return out;
}

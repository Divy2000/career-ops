// Pure helpers for the immigration-policy watcher and the per-company
// sponsorship freshness check. No I/O here, so every rule is unit-tested.

export const WINDOW_DAYS = 15;
export const BASELINE_DAYS = 7;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LEGAL_SUFFIXES = /\b(inc|llc|ltd|corp|corporation|co|plc|gmbh)\b\.?/g;

const RELEVANT = [
  /\bh-?1b\b/i,
  /\bh-?1b1\b/i,
  /nonimmigrant worker/i,
  /specialty occupation/i,
  /labor condition application/i,
  /\blca\b/i,
  /prevailing wage/i,
  /\bperm\b/i,
  /labor certification/i,
  /employment-based/i,
  /\bi-140\b/i,
  /\bi-485\b/i,
  /adjustment of status/i,
  /green card/i,
  /visa bulletin/i,
  /\b(stem )?opt\b/i,
  /optional practical training/i,
  /\bo-1\b/i,
  /\bl-1\b/i,
  /work authorization/i,
  /employment authorization/i,
];
const IRRELEVANT = [/\beb-5\b/i, /regional center/i];

function isRealDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function assertIsoDate(value, name) {
  if (!isRealDate(value)) {
    throw new Error(`${name} must be a real YYYY-MM-DD date, got ${JSON.stringify(value)}`);
  }
}

export const ALERT_STATUSES = new Set(['paused', 'stopped', 'restricted', 'resumed', 'expanded']);
export const SOURCE_LOOKBACK_DAYS = 14;

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

export function companySlug(name) {
  const base = String(name ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[()]/g, ' ')
    .replace(/[.,]/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) throw new Error(`company name is empty after normalization: ${JSON.stringify(name)}`);
  return base;
}

function decodeXmlText(raw) {
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  const text = cdata ? cdata[1] : raw;
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeXmlText(m[1]) : '';
}

function toIsoDate(dateText) {
  const ms = Date.parse(dateText);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

export function parseRssItems(xml) {
  const items = [];
  for (const m of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const pub = tag(block, 'pubDate') || tag(block, 'dc:date');
    // pubDate carries the publisher's offset; keep the publisher's calendar day.
    const local = pub.match(/\d{1,2} \w{3} \d{4}/);
    items.push({
      title: tag(block, 'title'),
      url: tag(block, 'link'),
      date: local ? toIsoDate(`${local[0]} 00:00:00 UTC`) : toIsoDate(pub),
    });
  }
  return items;
}

export function isRelevantPolicyItem(title) {
  const t = String(title ?? '');
  if (IRRELEVANT.some((re) => re.test(t))) return false;
  return RELEVANT.some((re) => re.test(t));
}

// The daily prompt asks for exactly six tab-separated fields per row: a tab inside a field shifts every column after
// it, so a row with another count is refused rather than read with its data truncated or shifted.
function splitRow(line, names) {
  const fields = line.split('\t');
  if (fields.length !== names.length) throw new Error(`expected ${names.length} tab-separated fields, got ${fields.length}`);
  return fields;
}

function assertFilled(fields, names, optional = []) {
  names.forEach((name, i) => {
    if (!optional.includes(name) && !fields[i].trim()) throw new Error(`${name} is empty`);
  });
}

const POLICY_FIELDS = ['detected_date', 'announced_date', 'source', 'title', 'url', 'impact'];
const ALERT_FIELDS = ['date', 'company', 'slug', 'status', 'headline', 'url'];

export function parsePolicyChanges(tsv) {
  const rows = [];
  const lines = String(tsv ?? '').replace(/\r/g, '').split('\n');
  lines.forEach((line, i) => {
    if (!line.trim() || (i === 0 && line.startsWith('detected_date\t'))) return;
    let detected, announced, source, title, url, impact;
    try {
      const fields = splitRow(line, POLICY_FIELDS);
      [detected, announced, source, title, url, impact] = fields;
      announced = announced.trim();
      assertIsoDate(detected, 'detected_date');
      assertFilled(fields, POLICY_FIELDS, ['announced_date']);
      if (announced) assertIsoDate(announced, 'announced_date');
    } catch (err) {
      throw new Error(`policy-changes.tsv line ${i + 1}: ${err.message}`);
    }
    rows.push({ detected, announced: announced || detected, source, title, url, impact });
  });
  return rows;
}

export function parseCompanyAlerts(tsv) {
  const bySlug = new Map();
  String(tsv ?? '').replace(/\r/g, '').split('\n').forEach((line, i) => {
    if (!line.trim() || (i === 0 && line.startsWith('date\t'))) return;
    let date, company, slug, status, headline, url;
    try {
      const fields = splitRow(line, ALERT_FIELDS);
      [date, company, slug, status, headline, url] = fields;
      assertIsoDate(date, 'date');
      assertFilled(fields, ALERT_FIELDS);
      if (!ALERT_STATUSES.has(status)) throw new Error(`status must be one of ${[...ALERT_STATUSES].join('/')}, got ${JSON.stringify(status)}`);
    } catch (err) {
      throw new Error(`company-alerts.tsv line ${i + 1}: ${err.message}`);
    }
    const prev = bySlug.get(slug);
    if (!prev || date >= prev.date) bySlug.set(slug, { date, company, status, headline, url });
  });
  return bySlug;
}

export function readSeenChangeCount(markdown) {
  const m = String(markdown ?? '').match(/^policy_changes_seen:\s*(\d+)\s*$/m);
  return m ? Number(m[1]) : null;
}

// Items stay pending until the AI pass that records them succeeds, so a failed
// run cannot drop a policy change that the dedupe set has already seen.
export function mergePending(pending, fresh) {
  const out = [...pending];
  const ids = new Set(pending.map((i) => i.id));
  for (const item of fresh) {
    if (ids.has(item.id)) continue;
    ids.add(item.id);
    out.push(item);
  }
  return out;
}

export function sourceCursor(seen, source) {
  return seen?.last_success?.[source] ?? seen?.last_run ?? null;
}

export function sinceForSource({ lastSuccess, today, lookbackDays = SOURCE_LOOKBACK_DAYS }) {
  assertIsoDate(today, 'today');
  const floor = new Date(Date.parse(`${today}T00:00:00Z`) - lookbackDays * 86400000).toISOString().slice(0, 10);
  if (lastSuccess === null || lastSuccess === undefined) return floor;
  assertIsoDate(lastSuccess, 'lastSuccess');
  return lastSuccess < floor ? lastSuccess : floor;
}

/**
 * Where the policy pass's news search starts: the date of the last successful pass (watch.mjs --ack records it), so
 * news from days the pass was skipped or failed is still searched, and never later than `windowDays` before today.
 */
export function newsSince({ lastPass, today, windowDays = 3 }) {
  assertIsoDate(today, 'today');
  const floor = new Date(Date.parse(`${today}T00:00:00Z`) - windowDays * 86400000).toISOString().slice(0, 10);
  if (lastPass === null || lastPass === undefined) return floor;
  assertIsoDate(lastPass, 'lastPass');
  return lastPass < floor ? lastPass : floor;
}

/**
 * The digest with a dated section saying the AI pass was skipped and why, directly under the title (newest first,
 * like the pass's own sections); unchanged when today's newest section already says it. A missing title is added.
 */
export function noteSkippedPass(digest, today, reason) {
  const bullet = `- AI policy pass skipped: ${String(reason).replace(/\s*[\r\n]+\s*/g, ' ').trim()}`;
  const section = `## ${today}\n${bullet}\n`;
  const lines = String(digest ?? '').split('\n');
  const t = lines.findIndex((l) => /^# /.test(l));
  const head = t === -1 ? '# Immigration policy digest' : lines.slice(0, t + 1).join('\n');
  const rest = (t === -1 ? lines : lines.slice(t + 1)).join('\n').replace(/^\n+/, '');
  if (rest.startsWith(section)) return `${head}\n\n${rest}`;
  return `${head}\n\n${section}${rest ? `\n${rest}` : ''}`;
}

export function readCheckedAt(markdown) {
  const m = String(markdown ?? '').match(/^checked_at:\s*(\d{4}-\d{2}-\d{2})\s*$/m);
  return m ? m[1] : null;
}

export function decideRefresh({ today, checkedAt, changes, seenChangeCount = null, windowDays = WINDOW_DAYS, baselineDays = BASELINE_DAYS }) {
  assertIsoDate(today, 'today');
  if (checkedAt === null || checkedAt === undefined) {
    return { refresh: true, reason: 'no saved check for this company' };
  }
  assertIsoDate(checkedAt, 'checkedAt');

  const past = changes.filter((c) => c.detected <= today && c.announced <= today);

  // The saved check records how many applicable policy rows existed when it was
  // made, so a change logged later the same day still forces a refresh.
  if (seenChangeCount !== null && past.length > seenChangeCount) {
    return { refresh: true, reason: `policy change recorded after the last check (${past.length - seenChangeCount} new)` };
  }

  // Files written before policy_changes_seen existed: treat a change detected on
  // the check day as possibly later than the check.
  if (seenChangeCount === null) {
    const detectedSinceCheck = past.filter((c) => c.detected >= checkedAt);
    if (detectedSinceCheck.length) {
      const latest = detectedSinceCheck.map((c) => c.detected).sort().at(-1);
      return { refresh: true, reason: `policy change detected ${latest}, on or after the last check on ${checkedAt}` };
    }
  }

  const openWindows = past.filter((c) => daysBetween(c.announced, today) <= windowDays);
  if (openWindows.length && checkedAt < today) {
    const latest = openWindows.map((c) => c.announced).sort().at(-1);
    return { refresh: true, reason: `inside the ${windowDays}-day window after the policy change announced ${latest}; refreshing daily` };
  }

  const age = daysBetween(checkedAt, today);
  if (age >= baselineDays) {
    return { refresh: true, reason: `saved check is ${age} days old (refresh every ${baselineDays} days)` };
  }
  return { refresh: false, reason: `saved check from ${checkedAt} is current` };
}

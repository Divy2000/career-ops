// Pure helpers for pipeline ordering and the sponsorship-aware shortlist.

const PRIORITY_TITLE = /backend|back-end|back end|python|django|\bapi\b|\bai\b|\bml\b|machine learning|llm|applied ai|agentic/i;
const FRESH_DAYS = 30;
// Labeled segments scan.mjs and rank-pipeline.mjs append to pipeline rows.
const ROW_LABEL = /^(trust|note|posted|rank): (.*)$/;
const STALE_DAYS = 60;

// Added to the relevance rank (0-5). DOL history is backward-looking, so even
// "strong" is only a small boost; "none" is a heavy penalty, not an exclusion,
// because young companies can sponsor before they appear in DOL data.
const TIER_DELTA = {
  strong: 0.5,
  moderate: 0.2,
  unknown: -0.3,
  weak: -1.0,
  none: -1.5,
  'staffing-shop': -1.5,
};
const EXCLUDING_ALERTS = new Set(['paused', 'stopped', 'restricted']);

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

export function parseRow(line) {
  const m = String(line).match(/^- \[( |x)\] (.*)$/);
  if (!m) return null;
  const parts = m[2].split(' | ');
  const row = {
    raw: line,
    pending: m[1] === ' ',
    url: parts[0].trim(),
    company: '',
    title: '',
    location: '',
    posted: null,
    rank: null,
    rankReason: '',
    labels: {},
  };
  // Labeled segments can appear anywhere (a bare-URL row may carry only a
  // rank), so pull them out before assigning positional fields.
  // Labels are only recognized as a trailing run of segments, so a free-text
  // field that happens to start with "note:" stays positional.
  const rest = parts.slice(1);
  let firstLabel = rest.length;
  while (firstLabel > 0 && ROW_LABEL.test(rest[firstLabel - 1])) firstLabel--;
  const positional = rest.slice(0, firstLabel).map((seg) => seg.trim());
  for (const seg of rest.slice(firstLabel)) {
    const posted = seg.match(/^posted: (\d{4}-\d{2}-\d{2})$/);
    const rank = seg.match(/^rank: ([\d.]+)\/5 \u2014 (.*)$/);
    const [, label, value] = seg.match(ROW_LABEL);
    if (posted) row.posted = posted[1];
    else if (rank) {
      row.rank = Number(rank[1]);
      row.rankReason = rank[2].trim();
    } else row.labels[label] = value.trim();
  }
  [row.company = '', row.title = '', row.location = ''] = positional;
  return row;
}

export function orderPending(lines, { today, firstSeen }) {
  const keyed = lines.map((line, i) => {
    const r = parseRow(line);
    const age = r?.posted ? daysBetween(r.posted, today) : 0;
    return {
      line,
      key: [
        firstSeen.get(r?.url) === today ? 0 : 1,
        age <= FRESH_DAYS ? 0 : age <= STALE_DAYS ? 1 : 2,
        PRIORITY_TITLE.test(r?.title ?? '') ? 0 : 1,
        age,
        i,
      ],
    };
  });
  keyed.sort((a, b) => {
    for (let k = 0; k < a.key.length; k++) if (a.key[k] !== b.key[k]) return a.key[k] - b.key[k];
    return 0;
  });
  return keyed.map((k) => k.line);
}

export function sponsorAdjustment({ tier, alert }) {
  if (!(tier in TIER_DELTA)) throw new Error(`unknown sponsorship tier: ${JSON.stringify(tier)}`);
  if (alert && EXCLUDING_ALERTS.has(alert.status)) {
    return { delta: 0, exclude: true, label: `${alert.status} (${alert.date}): ${alert.headline}` };
  }
  const note = alert ? `; ${alert.status} ${alert.date}` : '';
  return { delta: TIER_DELTA[tier], exclude: false, label: `${tier}${note}` };
}

const LEGAL_WORDS = new Set(['inc', 'llc', 'ltd', 'corp', 'corporation', 'co', 'na', 'plc', 'lp', 'llp']);

function nameWords(name) {
  return String(name ?? '').toLowerCase().replace(/&/g, ' ').split(/[^a-z0-9]+/).filter((w) => w && !LEGAL_WORDS.has(w));
}

// DOL filings use legal names ("JPMORGAN CHASE & CO") while job feeds use brand
// names ("JPMorganChase"). Accept a candidate when some leading run of its words,
// joined, spells the company name exactly; candidates arrive ordered by filing
// volume, so the first hit is the main filer.
export function pickSearchMatch(company, candidates) {
  const target = nameWords(company).join('');
  if (!target) return null;
  for (const cand of candidates) {
    const words = nameWords(cand);
    for (let k = 1; k <= words.length; k++) {
      const joined = words.slice(0, k).join('');
      if (joined === target) return cand;
      if (joined.length >= target.length) break;
    }
  }
  return null;
}

export function buildShortlist(rows, { tiers, alerts, minRank = 3, keep = () => true }) {
  const shortlist = [];
  const excluded = [];
  const best = new Map();
  for (const r of rows) {
    if (!r?.pending || r.rank === null || r.rank < minRank || !keep(r)) continue;
    // A row with no company or title (a pasted URL) is only a duplicate of the same posting URL.
    const dedupeKey = r.company && r.title ? `${r.company.toLowerCase()}\u0000${r.title.toLowerCase()}` : `url\u0000${r.url.replace(/#.*$/, '').replace(/\/+$/, '')}`;
    const prev = best.get(dedupeKey);
    if (!prev || r.rank > prev.rank) best.set(dedupeKey, r);
  }
  for (const r of best.values()) {
    const tier = tiers.get(r.company) ?? 'unknown';
    const adj = sponsorAdjustment({ tier, alert: alerts.get(r.company) ?? null });
    const item = { ...r, tier, sponsor: adj.label, score: Math.round((r.rank + adj.delta) * 10) / 10 };
    (adj.exclude ? excluded : shortlist).push(item);
  }
  const byScore = (a, b) => b.score - a.score || b.rank - a.rank;
  return { shortlist: shortlist.sort(byScore), excluded: excluded.sort(byScore) };
}

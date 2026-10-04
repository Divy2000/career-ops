// Pure helpers for the projects library (article-digest.md): parse, validate,
// serialize, edit one entry in place, append, and convert JSON project lists.
//
// Format: one `## Title`, `## Title -- <url>`, `## Title -- [text](url)`,
// `## Title -- tagline` or `## [Title](url)` block per entry, optional
// `Tags:` / `Kind:` / `Dates:` lines right after the heading, then top-level
// `- ` bullets (the copy-paste points). Upstream digest blocks are accepted:
// when an entry has a `**Proof points:**` label, only its bullets count.

import { normalizeTextKey } from '../../tracker-parse.mjs';
import { extractSkills } from '../../skill-extract.mjs';

export const KINDS = ['project', 'publication', 'article'];
export const LIBRARY_HEADER = '# Projects library';
const MAX_BULLETS = 8;
const WARN_BULLETS = 6;
const ENTRY_SEPARATOR = '\n\n---\n\n';

// ` -- `, or a spaced em/en dash, splits the name from its link or tagline.
// A single spaced hyphen does not, so "Multi-agent - Planner" stays one title.
const HEADING_SEP = /\s+(?:--|\u2014|\u2013)\s+/;
const HEADING_SEP_AT_START = /^\s*(?:--|\u2014|\u2013)\s+/;
const HTTP_URL = /^https?:\/\/\S+$/i;
const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const META = /^(tags|kind|dates)\s*:\s*(.*?)\s*$/i;
const BULLET = /^[-*]\s+(.*\S)\s*$/;
const LABEL = /^\*\*([^*]+?):?\*\*:?/;

export function titleKey(title) {
  return normalizeTextKey(title);
}

export function projectId(title) {
  return normalizeTextKey(title, '-').replace(/^-+|-+$/g, '');
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function parseLink(text) {
  const md = text.match(/^\[([^\]]*)\]\(([^)\s]*)\)$/);
  if (md) return md[2];
  const angle = text.match(/^<([^>\s]+)>$/);
  if (angle) return angle[1];
  if (/^[a-z][a-z0-9+.-]*:\S+$/i.test(text)) return text;
  return null;
}

function parseHeading(raw) {
  const s = raw.trim();
  let title;
  let link = null;
  let tagline = null;
  const lead = s.match(/^\[([^\]]+)\]\(([^)\s]*)\)(.*)$/);
  if (lead) {
    title = lead[1].trim();
    link = lead[2];
    const rest = lead[3];
    if (HEADING_SEP_AT_START.test(rest)) tagline = rest.replace(HEADING_SEP_AT_START, '').trim() || null;
  } else {
    const m = s.match(HEADING_SEP);
    if (m) {
      title = s.slice(0, m.index).trim();
      const rest = s.slice(m.index + m[0].length).trim();
      link = parseLink(rest);
      if (link === null) tagline = rest || null;
    } else {
      title = s;
    }
  }
  const url = link !== null && HTTP_URL.test(link) ? link : null;
  return { title, url, tagline, invalidUrl: link !== null && url === null ? link : null };
}

function parseBody(lines) {
  const meta = { tags: [], kind: 'project', dates: null };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const m = line.match(META);
    if (!m) break;
    const key = m[1].toLowerCase();
    if (key === 'tags') meta.tags = m[2].split(',').map((t) => t.trim()).filter(Boolean);
    else if (key === 'kind') meta.kind = m[2].toLowerCase();
    else meta.dates = m[2] || null;
    i++;
  }
  const rest = lines.slice(i);
  const isProofLabel = (l) => /^proof points$/i.test(l.match(LABEL)?.[1]?.trim() ?? '');
  const hasProof = rest.some(isProofLabel);
  const bullets = [];
  let collecting = !hasProof;
  let inFence = false;
  let open = false;
  for (const line of rest) {
    if (FENCE.test(line)) { inFence = !inFence; open = false; continue; }
    if (inFence) continue;
    if (LABEL.test(line)) { collecting = hasProof ? isProofLabel(line) : true; open = false; continue; }
    const b = line.match(BULLET);
    if (b && !RULE.test(line)) {
      if (collecting) bullets.push(b[1]);
      open = collecting;
      continue;
    }
    if (open && /^\s+\S/.test(line) && !/^\s+(?:[-*+]|\d+[.)])\s/.test(line)) {
      bullets[bullets.length - 1] += ` ${line.trim()}`;
      continue;
    }
    open = false;
  }
  return { ...meta, bullets };
}

// Each entry carries character offsets: [start, end) is the heading through
// its last content line, so separators and blank lines stay outside it.
export function parseLibrary(text) {
  const src = String(text ?? '');
  const lines = src.split('\n');
  const starts = [];
  let pos = 0;
  for (const l of lines) { starts.push(pos); pos += l.length + 1; }
  const clean = lines.map((l) => l.replace(/\r$/, ''));
  const headings = [];
  let inFence = false;
  clean.forEach((l, i) => {
    if (FENCE.test(l)) inFence = !inFence;
    else if (!inFence && /^##(?!#)\s+\S/.test(l)) headings.push(i);
  });
  const entries = headings.map((h, k) => {
    const next = k + 1 < headings.length ? headings[k + 1] : clean.length;
    let last = next - 1;
    while (last > h && (!clean[last].trim() || RULE.test(clean[last]))) last--;
    const head = parseHeading(clean[h].replace(/^##\s+/, ''));
    const body = parseBody(clean.slice(h + 1, last + 1));
    return {
      id: projectId(head.title),
      ...head,
      ...body,
      line: h + 1,
      start: starts[h],
      end: starts[last] + clean[last].length,
    };
  });
  return { preamble: src.slice(0, headings.length ? starts[headings[0]] : src.length), entries };
}

export function validateLibrary(text) {
  const { entries } = parseLibrary(text);
  const errors = [];
  const warnings = [];
  const seen = new Map();
  for (const e of entries) {
    const where = `line ${e.line}: "${e.title}"`;
    if (!e.title) errors.push(`line ${e.line}: entry has no title`);
    const key = titleKey(e.title);
    if (key && seen.has(key)) {
      const first = seen.get(key);
      errors.push(`duplicate title: "${first.title}" (line ${first.line}) and "${e.title}" (line ${e.line})`);
    } else if (key) {
      seen.set(key, e);
    }
    if (e.invalidUrl) errors.push(`${where} link must be http(s), got "${e.invalidUrl}" (dropped)`);
    if (!KINDS.includes(e.kind)) errors.push(`${where} unknown kind "${e.kind}"; use one of ${KINDS.join(', ')}`);
    if (e.kind === 'project') {
      const n = e.bullets.length;
      if (n === 0) errors.push(`${where} has no copy-paste points (add 1 to ${MAX_BULLETS} "- " bullets)`);
      else if (n > MAX_BULLETS) errors.push(`${where} has ${n} bullets; keep at most ${MAX_BULLETS}`);
      else if (n > WARN_BULLETS) warnings.push(`${where} has ${n} bullets; ${WARN_BULLETS} or fewer copy-paste best`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function serializeEntry(entry) {
  const title = oneLine(entry?.title);
  if (!title) throw new Error('entry needs a non-empty title');
  if (HEADING_SEP.test(title)) throw new Error(`title "${title}" must not contain " -- " or a spaced dash; it would split the heading`);
  const url = entry.url ? oneLine(entry.url) : null;
  if (url && !HTTP_URL.test(url)) throw new Error(`link for "${title}" must be http(s), got "${url}"`);
  const tagline = oneLine(entry.tagline) || null;
  let heading;
  if (url && tagline) heading = `## [${title}](${url}) -- ${tagline}`;
  else if (url) heading = `## ${title} -- ${url}`;
  else if (tagline) heading = `## ${title} -- ${tagline}`;
  else heading = `## ${title}`;
  const out = [heading];
  const tags = (entry.tags ?? []).map(oneLine).filter(Boolean);
  if (tags.length) out.push(`Tags: ${tags.join(', ')}`);
  const kind = oneLine(entry.kind).toLowerCase();
  if (kind && kind !== 'project') out.push(`Kind: ${kind}`);
  const dates = oneLine(entry.dates);
  if (dates) out.push(`Dates: ${dates}`);
  for (const b of entry.bullets ?? []) {
    const line = oneLine(b);
    if (line) out.push(`- ${line}`);
  }
  return out.join('\n');
}

export function serializeLibrary(entries) {
  return `${LIBRARY_HEADER}\n\n${entries.map(serializeEntry).join(ENTRY_SEPARATOR)}\n`;
}

function assertNewTitle(entries, title, exceptId) {
  const key = titleKey(title);
  const clash = entries.find((e) => e.id !== exceptId && titleKey(e.title) === key);
  if (clash) throw new Error(`"${clash.title}" is already in the library`);
}

export function replaceEntry(text, id, entry) {
  const { entries } = parseLibrary(text);
  const target = entries.find((e) => e.id === id);
  if (!target) throw new Error(`no entry with id "${id}"`);
  const block = serializeEntry(entry);
  assertNewTitle(entries, entry.title, id);
  return text.slice(0, target.start) + block + text.slice(target.end);
}

// Appends a ready-made markdown block (already validated by the caller).
export function appendBlock(text, block) {
  const body = block.replace(/\s+$/, '');
  const base = String(text ?? '').replace(/\s+$/, '');
  if (!base) return `${LIBRARY_HEADER}\n\n${body}\n`;
  const sep = parseLibrary(base).entries.length ? ENTRY_SEPARATOR : '\n\n';
  return `${base}${sep}${body}\n`;
}

export function appendEntry(text, entry) {
  const block = serializeEntry(entry);
  assertNewTitle(parseLibrary(text).entries, entry.title, null);
  return appendBlock(text, block);
}

const stringList = (value, field, where) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`${where}: "${field}" must be a list of strings`);
  }
  return value;
};

// Accepts an AutoJobApply-style list ({id,name,url,description,highlights,tags?|keywords?}),
// a JSON Resume `projects` array, or a whole JSON Resume object.
export function convertJsonProjects(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.projects) ? data.projects : null;
  if (!list) throw new Error('expected a projects array or an object with a "projects" array');
  const warnings = [];
  const entries = list.map((p, i) => {
    const where = `projects[${i}]`;
    if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !p.name.trim()) {
      throw new Error(`${where}: needs a non-empty "name"`);
    }
    const name = oneLine(p.name);
    let title = name;
    if (HEADING_SEP.test(title)) {
      title = title.split(HEADING_SEP).join(' - ');
      warnings.push(`${where} "${name}": renamed to "${title}" because " -- " splits a library heading`);
    }
    let url = typeof p.url === 'string' && p.url.trim() ? p.url.trim() : null;
    if (url && !HTTP_URL.test(url)) {
      warnings.push(`${where} "${name}": dropped non-http(s) url "${url}"`);
      url = null;
    }
    if (p.description !== undefined && typeof p.description !== 'string') {
      throw new Error(`${where}: "description" must be a string`);
    }
    const highlights = stringList(p.highlights, 'highlights', where);
    const tags = p.tags !== undefined ? stringList(p.tags, 'tags', where) : stringList(p.keywords, 'keywords', where);
    const start = oneLine(p.startDate);
    const end = oneLine(p.endDate);
    const dates = start ? `${start} - ${end || 'Present'}` : end || null;
    return {
      title,
      url,
      tags: tags.map(oneLine).filter(Boolean),
      kind: 'project',
      dates,
      bullets: [p.description, ...highlights].map(oneLine).filter(Boolean),
    };
  });
  return { entries, warnings };
}

// The entry named `title` in cv.md: a `##`-`######` heading whose name (text
// before the separator) matches, or a `**Title**` list item. Returns the
// entry's text without the title, or null when cv.md does not list it.
export function findCvEntry(cvText, title) {
  const key = titleKey(title);
  if (!key) return null;
  const lines = String(cvText ?? '').split('\n').map((l) => l.replace(/\r$/, ''));
  const plain = (s) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^#{2,6}\s+(.*\S)\s*$/);
    if (h && titleKey(plain(h[1]).split(HEADING_SEP)[0]) === key) {
      const body = [];
      for (let j = i + 1; j < lines.length && !/^#{1,6}\s/.test(lines[j]); j++) body.push(lines[j]);
      return { line: i + 1, text: oneLine(body.map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')).join(' ')) };
    }
    const b = lines[i].match(/^\s*(?:[-*+]\s+)?\*\*(.+?)\*\*(.*)$/);
    if (b && titleKey(plain(b[1])) === key) {
      const rest = [b[2].replace(/^\s*\([^)]*\)/, '').replace(/^\s*(?:--|\u2014|\u2013|-|:)\s*/, '')];
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) rest.push(lines[j]);
      return { line: i + 1, text: oneLine(rest.join(' ')) };
    }
  }
  return null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, term) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
const byCodepoint = (a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);

const WEIGHT = { title: 3, tags: 2, bullets: 1 };
const RECOMMEND_MIN = 2;
const RECOMMEND_MAX = 4;
const RECOMMEND_RATIO = 0.6;

// Deterministic, no AI. Each JD skill (upstream skill vocabulary) a project
// shows scores by where it appears: title 3, tags 2, bullets 1. A tag outside
// the vocabulary that the JD names literally scores the same way (title 3 when
// the title also names it, else 2). Ties keep library order.
export function rankProjects(entries, { jdText, cvText = '' }) {
  const jdSkills = extractSkills(jdText);
  const cvSkills = extractSkills(cvText);
  const candidates = [];
  const excluded = [];
  const skillsOf = new Map();
  for (const e of entries) {
    if (e.kind !== 'project') {
      excluded.push({ id: e.id, title: e.title, kind: e.kind });
      continue;
    }
    const where = {
      title: extractSkills(e.title),
      tags: extractSkills(e.tags.join(', ')),
      bullets: extractSkills([e.tagline ?? '', ...e.bullets].join('\n')),
    };
    skillsOf.set(e.id, new Set([...where.title, ...where.tags, ...where.bullets]));
    const matched = new Map();
    for (const skill of jdSkills) {
      const field = ['title', 'tags', 'bullets'].find((f) => where[f].has(skill));
      if (field) matched.set(skill, WEIGHT[field]);
    }
    for (const tag of e.tags) {
      if (extractSkills(tag).size || matched.has(tag) || !mentions(jdText, tag)) continue;
      matched.set(tag, mentions(e.title, tag) ? WEIGHT.title : WEIGHT.tags);
    }
    candidates.push({
      id: e.id,
      title: e.title,
      url: e.url ?? null,
      kind: e.kind,
      inCv: findCvEntry(cvText, e.title) !== null,
      score: [...matched.values()].reduce((a, b) => a + b, 0),
      matchedSkills: [...matched.keys()].sort(byCodepoint),
      bullets: [...e.bullets],
    });
  }
  const libraryOrder = candidates.map((c) => c.id);
  candidates.sort((a, b) => b.score - a.score);
  const scored = candidates.filter((c) => c.score > 0);
  const top = scored[0]?.score ?? 0;
  const recommended = scored
    .slice(0, RECOMMEND_MAX)
    .filter((c, i) => i < RECOMMEND_MIN || c.score >= RECOMMEND_RATIO * top)
    .map((c) => c.id);
  const libraryCoverage = {};
  for (const skill of [...jdSkills].sort(byCodepoint)) {
    if (cvSkills.has(skill)) continue;
    const ids = libraryOrder.filter((id) => skillsOf.get(id).has(skill));
    if (ids.length) libraryCoverage[skill] = ids;
  }
  return { recommended, candidates, excluded, libraryCoverage };
}

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
// `Source:` is provenance: the documents/ file an imported entry came from (see intake).
const META = /^(tags|kind|dates|source)\s*:\s*(.*?)\s*$/i;
const BULLET = /^[-*]\s+(.*\S)\s*$/;
const LABEL = /^\*\*([^*]+?):?\*\*:?/;

export function titleKey(title) {
  return normalizeTextKey(title);
}

export function projectId(title) {
  return normalizeTextKey(title, '-').replace(/^-+|-+$/g, '');
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// `[text](url)` at the start of `s`, with balanced parentheses inside the URL
// (https://example.com/a_(b)). `rest` is whatever follows the closing paren.
// The text may hold backslash-escaped characters (`\]`), as markdown allows and mdLinkText writes.
function readMdLink(s) {
  const m = s.match(/^\[((?:\\.|[^\]\\])*)\]\(/);
  if (!m) return null;
  const text = m[1].replace(/\\([\\[\]])/g, '$1');
  let depth = 1;
  let i = m[0].length;
  for (; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) break;
  }
  if (depth !== 0) return { text, url: null, rest: '', unbalanced: true };
  return { text, url: s.slice(m[0].length, i).trim(), rest: s.slice(i + 1) };
}

const mdLinkText = (title) => title.replace(/[\\[\]]/g, '\\$&');

function parseLink(text) {
  const md = readMdLink(text);
  if (md) return { link: md.url, trailing: md.rest.trim(), unbalanced: md.unbalanced };
  const angle = text.match(/^<([^>\s]+)>(.*)$/);
  if (angle) return { link: angle[1], trailing: angle[2].trim() };
  const bare = text.match(/^([a-z][a-z0-9+.-]*:\S+)(?:\s+(.*))?$/i);
  if (bare && (!bare[2] || bare[1].includes('://'))) return { link: bare[1], trailing: (bare[2] ?? '').trim() };
  return null;
}

function headingProblem({ trailing, unbalanced }) {
  if (unbalanced) return 'has unbalanced parentheses in its link';
  return trailing ? `has unexpected text after the link: "${trailing}"` : null;
}

function parseHeading(raw) {
  const s = raw.trim();
  let title;
  let link = null;
  let tagline = null;
  let problem = null;
  const lead = readMdLink(s);
  if (lead && lead.text.trim()) {
    title = lead.text.trim();
    link = lead.url;
    if (HEADING_SEP_AT_START.test(lead.rest)) tagline = lead.rest.replace(HEADING_SEP_AT_START, '').trim() || null;
    else problem = headingProblem({ trailing: lead.rest.trim(), unbalanced: lead.unbalanced });
  } else {
    const m = s.match(HEADING_SEP);
    if (m) {
      title = s.slice(0, m.index).trim();
      const rest = s.slice(m.index + m[0].length).trim();
      const parsed = parseLink(rest);
      if (parsed) {
        link = parsed.link;
        problem = headingProblem(parsed);
      } else {
        tagline = rest || null;
      }
    } else {
      title = s;
    }
  }
  const url = link !== null && HTTP_URL.test(link) ? link : null;
  return { title, url, tagline, invalidUrl: link !== null && url === null ? link : null, headingProblem: problem };
}

// Besides the fields, returns where they sit (body line indices): the meta
// lines, each collected bullet's [from, to] span (with its continuation
// lines) and the Proof points label, so an edit can rewrite just those lines.
function parseBody(lines) {
  const meta = { tags: [], kind: 'project', dates: null, source: null };
  const metaLines = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const m = line.match(META);
    if (!m) break;
    const key = m[1].toLowerCase();
    if (key === 'tags') meta.tags = m[2].split(',').map((t) => t.trim()).filter(Boolean);
    else if (key === 'kind') meta.kind = m[2].toLowerCase();
    else if (key === 'source') meta.source = m[2] || null;
    else meta.dates = m[2] || null;
    metaLines.push(i);
    i++;
  }
  const isProofLabel = (l) => /^proof points$/i.test(l.match(LABEL)?.[1]?.trim() ?? '');
  const hasProof = lines.slice(i).some(isProofLabel);
  const bullets = [];
  const spans = [];
  let proofLabel = null;
  let collecting = !hasProof;
  let inFence = false;
  let open = false;
  for (let k = i; k < lines.length; k++) {
    const line = lines[k];
    if (FENCE.test(line)) { inFence = !inFence; open = false; continue; }
    if (inFence) continue;
    if (LABEL.test(line)) {
      collecting = hasProof ? isProofLabel(line) : true;
      if (hasProof && collecting && proofLabel === null) proofLabel = k;
      open = false;
      continue;
    }
    const b = line.match(BULLET);
    if (b && !RULE.test(line)) {
      if (collecting) { bullets.push(b[1]); spans.push([k, k]); }
      open = collecting;
      continue;
    }
    if (open && /^\s+\S/.test(line) && !/^\s+(?:[-*+]|\d+[.)])\s/.test(line)) {
      bullets[bullets.length - 1] += ` ${line.trim()}`;
      spans[spans.length - 1][1] = k;
      continue;
    }
    open = false;
  }
  return { fields: { ...meta, bullets }, layout: { metaLines, spans, proofLabel } };
}

// The form owns the heading, the meta lines and the copy-paste bullets. It can
// rewrite the bullets in place only when they form one run with nothing but
// blank lines between them; anything else there would lose its position.
function layoutProblem(lines, { spans }) {
  if (!spans.length) return null;
  const owned = new Set(spans.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, k) => a + k)));
  for (let k = spans[0][0]; k <= spans[spans.length - 1][1]; k++) {
    if (!owned.has(k) && lines[k].trim()) {
      return 'it has text or nested items between its copy-paste bullets, which the form cannot keep in place; edit article-digest.md directly';
    }
  }
  // A nested item or a lazy continuation right after the last bullet belongs to that bullet, but a rewrite would leave
  // it in place, under whichever bullet ends up last. A label, fence, rule or heading there starts its own block.
  // After blank lines any indented line still continues that bullet, a label, fence, rule or heading included; only an
  // unindented line starts its own block.
  const last = spans[spans.length - 1][1];
  const after = lines[last + 1] ?? '';
  const ownBlock = (l) => LABEL.test(l) || FENCE.test(l) || RULE.test(l) || /^#{1,6}(\s|$)/.test(l);
  let next = last + 1;
  while (next < lines.length && !lines[next].trim()) next++;
  const later = next > last + 1 ? lines[next] ?? '' : '';
  if (/^\s+\S/.test(after) || (after.trim() && !ownBlock(after)) || /^\s+\S/.test(later)) {
    return 'it has a nested item or text right after its last copy-paste bullet, which the form cannot keep with that bullet; edit article-digest.md directly';
  }
  return null;
}

// Each entry carries character offsets: [start, end) is the heading through
// its last content line, so separators and blank lines stay outside it.
function lineTable(src) {
  const lines = src.split('\n');
  const starts = [];
  let pos = 0;
  for (const l of lines) { starts.push(pos); pos += l.length + 1; }
  return { starts, clean: lines.map((l) => l.replace(/\r$/, '')) };
}

// An entry separator is an unindented rule; an indented one belongs to the list item above it.
const isBlankOrRule = (l) => !l.trim() || (RULE.test(l) && !/^\s/.test(l));

// A `# Section` heading is never part of an entry: it ends the one above it.
export function parseLibrary(text) {
  const { preamble, entries } = parseWithLayout(text);
  return { preamble, entries: entries.map(({ layout: _layout, ...e }) => e) };
}

function parseWithLayout(text) {
  const src = String(text ?? '');
  const { starts, clean } = lineTable(src);
  const headings = [];
  const breaks = [];
  let inFence = false;
  clean.forEach((l, i) => {
    if (FENCE.test(l)) inFence = !inFence;
    else if (!inFence && /^##(?!#)\s+\S/.test(l)) { headings.push(i); breaks.push(i); }
    else if (!inFence && /^#(?!#)\s+\S/.test(l)) breaks.push(i);
  });
  const entries = headings.map((h) => {
    const next = breaks.find((b) => b > h) ?? clean.length;
    let last = next - 1;
    while (last > h && isBlankOrRule(clean[last])) last--;
    const head = parseHeading(clean[h].replace(/^##\s+/, ''));
    const bodyLines = clean.slice(h + 1, last + 1);
    const { fields, layout } = parseBody(bodyLines);
    const metaSet = new Set(layout.metaLines);
    return {
      id: projectId(head.title),
      ...head,
      ...fields,
      // Every line under the heading but the meta lines: all labeled sections, paragraphs and bullets.
      body: bodyLines.filter((_, k) => !metaSet.has(k)).join('\n'),
      editProblem: layoutProblem(bodyLines, layout),
      line: h + 1,
      start: starts[h],
      end: starts[last] + clean[last].length,
      layout,
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
    else if (!e.id) errors.push(`${where} needs a letter or digit in its title; it gets no id and cannot be edited or removed`);
    const key = titleKey(e.title);
    if (key && seen.has(key)) {
      const first = seen.get(key);
      errors.push(`duplicate title: "${first.title}" (line ${first.line}) and "${e.title}" (line ${e.line})`);
    } else if (key) {
      seen.set(key, e);
    }
    if (e.headingProblem) errors.push(`${where} ${e.headingProblem}`);
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

function entryLines(entry) {
  const title = oneLine(entry?.title);
  if (!title) throw new Error('entry needs a non-empty title');
  if (!projectId(title)) throw new Error(`title "${title}" needs a letter or digit; it would get no id`);
  if (HEADING_SEP.test(title)) throw new Error(`title "${title}" must not contain " -- " or a spaced dash; it would split the heading`);
  const url = entry.url ? oneLine(entry.url) : null;
  if (url && !HTTP_URL.test(url)) throw new Error(`link for "${title}" must be http(s), got "${url}"`);
  const tagline = oneLine(entry.tagline) || null;
  let heading;
  if (url && tagline) heading = `## [${mdLinkText(title)}](${url}) -- ${tagline}`;
  else if (url) heading = `## ${title} -- ${url}`;
  else if (tagline) heading = `## ${title} -- ${tagline}`;
  else heading = `## ${title}`;
  const meta = [];
  const tags = (entry.tags ?? []).map(oneLine).filter(Boolean);
  if (tags.length) meta.push(`Tags: ${tags.join(', ')}`);
  const kind = oneLine(entry.kind).toLowerCase();
  if (kind && kind !== 'project') meta.push(`Kind: ${kind}`);
  const dates = oneLine(entry.dates);
  if (dates) meta.push(`Dates: ${dates}`);
  const source = oneLine(entry.source);
  if (source) meta.push(`Source: ${source}`);
  const bullets = (entry.bullets ?? []).map(oneLine).filter(Boolean).map((b) => `- ${b}`);
  return { heading, meta, bullets };
}

export function serializeEntry(entry) {
  const { heading, meta, bullets } = entryLines(entry);
  return [heading, ...meta, ...bullets].join('\n');
}

export function serializeLibrary(entries) {
  return `${LIBRARY_HEADER}\n\n${entries.map(serializeEntry).join(ENTRY_SEPARATOR)}\n`;
}

function assertNewTitle(entries, title, exceptId) {
  const key = titleKey(title);
  const clash = entries.find((e) => e.id !== exceptId && titleKey(e.title) === key);
  if (clash) throw new Error(`"${clash.title}" is already in the library`);
}

// Edits write new text in the file's own newline convention (CRLF or LF).
const newlineOf = (text) => (String(text ?? '').includes('\r\n') ? '\r\n' : '\n');
const withNewline = (s, nl) => s.replace(/\r?\n/g, nl);

const EDITED_FIELDS = ['title', 'url', 'tagline', 'tags', 'kind', 'dates', 'source', 'bullets'];

// Rewrites only the lines the form owns (heading, meta lines, copy-paste
// bullets) in place; every other line of the block stays byte for byte. A
// block whose bullets cannot be rewritten in place, or whose result would not
// read back as entered, is refused.
// The one entry with `id`. Punctuation folds away in ids (C#, C++ and C are all "c"), so two titles can share one: then
// either could be meant, and acting on the first would edit or delete the other project.
function uniqueIndex(entries, id) {
  const matches = entries.flatMap((e, i) => (e.id === id ? [i] : []));
  if (matches.length === 0) throw new Error(`no entry with id "${id}"`);
  if (matches.length > 1) throw new Error(`${matches.length} projects share the id "${id}" (${matches.map((i) => entries[i].title).join(', ')}); rename one in article-digest.md first`);
  return matches[0];
}

export function replaceEntry(text, id, entry) {
  const { entries } = parseWithLayout(text);
  const index = uniqueIndex(entries, id);
  const target = entries[index];
  const refuse = (why) => new Error(`"${target.title}" cannot be edited here: ${why}`);
  if (target.editProblem) throw refuse(target.editProblem);
  const fresh = entryLines(entry);
  assertNewTitle(entries, entry.title, id);
  const nl = newlineOf(text);
  const lines = text.slice(target.start, target.end).split('\n').map((l) => ({ text: l.replace(/\r$/, ''), cr: l.endsWith('\r') }));
  lines[lines.length - 1].cr = text[target.end] === '\r';
  const made = (l) => ({ text: l, cr: nl === '\r\n' });
  // Body indices are block indices minus the heading; splice from the bottom up so earlier indices hold.
  const { metaLines, spans, proofLabel } = target.layout;
  const at = (k) => k + 1;
  if (spans.length) lines.splice(at(spans[0][0]), spans[spans.length - 1][1] - spans[0][0] + 1, ...fresh.bullets.map(made));
  else if (fresh.bullets.length) lines.splice(proofLabel !== null ? at(proofLabel) + 1 : lines.length, 0, ...fresh.bullets.map(made));
  if (metaLines.length) lines.splice(at(metaLines[0]), metaLines[metaLines.length - 1] - metaLines[0] + 1, ...fresh.meta.map(made));
  else lines.splice(1, 0, ...fresh.meta.map(made));
  lines[0] = { ...lines[0], text: fresh.heading };
  const block = lines.map((l, k) => l.text + (k < lines.length - 1 && l.cr ? '\r' : '')).join('\n');
  const out = text.slice(0, target.start) + block + text.slice(target.end);
  const want = parseLibrary(serializeEntry(entry)).entries[0];
  const got = parseLibrary(out).entries;
  if (got.length !== entries.length || EDITED_FIELDS.some((f) => JSON.stringify(got[index][f]) !== JSON.stringify(want[f]))) {
    throw refuse('the edited block would not read back as entered; edit article-digest.md directly');
  }
  return out;
}

// Removes one entry with its separator; every other byte stays, including a
// `# Section` heading next to it. An entry with content after it takes the
// separator after it; the last one takes the separator before it.
export function removeEntry(text, id) {
  const { entries } = parseLibrary(text);
  const i = uniqueIndex(entries, id);
  const target = entries[i];
  const { starts, clean } = lineTable(text);
  let next = starts.findIndex((s) => s > target.end);
  if (next !== -1) while (next < clean.length && isBlankOrRule(clean[next])) next++;
  if (next !== -1 && next < clean.length) return text.slice(0, target.start) + text.slice(starts[next]);
  if (i === 0) return `${text.slice(0, target.start).replace(/\s+$/, '')}${newlineOf(text)}`;
  let prev = target.line - 2;
  while (prev >= 0 && isBlankOrRule(clean[prev])) prev--;
  return `${text.slice(0, starts[prev] + clean[prev].length)}${newlineOf(text)}`;
}

// Appends a ready-made markdown block (already validated by the caller).
export function appendBlock(text, block) {
  const nl = newlineOf(text);
  const body = block.replace(/\s+$/, '');
  const base = String(text ?? '').replace(/\s+$/, '');
  if (!base) return withNewline(`${LIBRARY_HEADER}\n\n${body}\n`, nl);
  const sep = parseLibrary(base).entries.length ? ENTRY_SEPARATOR : '\n\n';
  return base + withNewline(`${sep}${body}\n`, nl);
}

export function appendEntry(text, entry) {
  const block = serializeEntry(entry);
  const { entries } = parseLibrary(text);
  assertNewTitle(entries, entry.title, null);
  const out = appendBlock(text, block);
  const want = parseLibrary(block).entries[0];
  const got = parseLibrary(out).entries;
  if (got.length !== entries.length + 1 || EDITED_FIELDS.some((f) => JSON.stringify(got.at(-1)[f]) !== JSON.stringify(want[f]))
    || titleKey(want.title) !== titleKey(entry.title)) {
    throw new Error(`"${oneLine(entry.title)}" cannot be added: it would not read back as entered; edit article-digest.md directly`);
  }
  return out;
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

// The body of every cv.md `##` section whose title ends in "Project" or "Projects" ("Projects", "Personal Projects"): the only part of
// cv.md a project may come from, never an employer, a role, another section's title or a skill category.
export function projectSections(cvText) {
  const lines = String(cvText ?? '').split('\n').map((l) => l.replace(/\r$/, ''));
  const out = [];
  let inside = false;
  for (const line of lines) {
    // A `#` heading ends a section as a `##` one does, and starts no projects section.
    const section = line.match(/^#{1,2}(?!#)\s+(.*\S)\s*$/);
    if (section) {
      if (!line.startsWith('##')) {
        inside = false;
        continue;
      }
      // The last word names the section: "Selected Projects" lists projects, "Project Management" does not.
      inside = /\bprojects?$/i.test(section[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[^A-Za-z]+$/, ''));
      continue;
    }
    if (inside) out.push(line);
  }
  return out.join('\n');
}

// The entry named `title` in cv.md: a `##`-`######` heading whose name (text
// before the separator) matches, with its body up to the next heading, or a
// `**Title**` list item with its indented continuation lines. Returns the raw
// lines (`line`/`endLine` are 1-based, inclusive) or null.
export function findCvBlock(cvText, title) {
  const located = locateCvEntry(cvText, title);
  if (!located) return null;
  return { line: located.start + 1, endLine: located.end + 1, raw: located.lines.slice(located.start, located.end + 1).join('\n') };
}

// The same entry's text without the title, or null when cv.md does not list it.
export function findCvEntry(cvText, title) {
  const located = locateCvEntry(cvText, title);
  return located ? { line: located.start + 1, text: located.text } : null;
}

function locateCvEntry(cvText, title) {
  const key = titleKey(title);
  if (!key) return null;
  const lines = String(cvText ?? '').split('\n').map((l) => l.replace(/\r$/, ''));
  const plain = (s) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^#{2,6}\s+(.*\S)\s*$/);
    if (h && titleKey(plain(h[1]).split(HEADING_SEP)[0]) === key) {
      let j = i + 1;
      while (j < lines.length && !/^#{1,6}\s/.test(lines[j])) j++;
      let end = j - 1;
      while (end > i && !lines[end].trim()) end--;
      const body = lines.slice(i + 1, j);
      return { lines, start: i, end, text: oneLine(body.map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')).join(' ')) };
    }
    const b = lines[i].match(/^\s*(?:[-*+]\s+)?\*\*(.+?)\*\*(.*)$/);
    if (b && titleKey(plain(b[1])) === key) {
      const rest = [b[2].replace(/^\s*\([^)]*\)/, '').replace(/^\s*(?:--|\u2014|\u2013|-|:)\s*/, '')];
      let j = i + 1;
      for (; j < lines.length && /^\s+\S/.test(lines[j]); j++) rest.push(lines[j]);
      return { lines, start: i, end: j - 1, text: oneLine(rest.join(' ')) };
    }
  }
  return null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, term) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
const byCodepoint = (a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);

const WEIGHT = { title: 3, tags: 2, body: 1 };
const RECOMMEND_MIN = 2;
const RECOMMEND_MAX = 4;
const RECOMMEND_RATIO = 0.6;
// A JD word outside the skill vocabulary is noisier than a named skill: it scores half a skill match at the
// same place, scaled by how rare it is across the library's projects.
const KEYWORD_WEIGHT = 0.5;
// Function words and the boilerplate every job description carries; they say nothing about fit.
const STOPWORDS = new Set(`
a about above across after again all also an and any are around as at be because been before being below between both but by
can could did do does doing down during each either etc few for from further had has have having here how if in into is it its
just least less like made more most much must no nor not now of off on once only or other our ours out over own per plus same should
so some such than that the their theirs them then there these they this those through to too under until up upon us use used uses
using very via was we were what when where which while who whom why will with within without would you your yours
ability able applicant applicants apply benefits best bonus build building candidate candidates collaborate collaboration
communication company day days degree environment equal every excellent experience experienced familiar familiarity field get good
great have help ideal ideally include includes including job join knowledge level looking love make makes minimum need needs new
nice one opportunity paced passion passionate plus preferred proficiency proficient related relevant required requirement
requirements responsibilities responsibility role roles salary senior junior skill skills strong team teams three time two
understanding want well work working year years engineer engineers engineering developer developers what you will`.split(/\s+/).filter(Boolean));

// Lowercase words, a trailing plural `s` folded the same way on both sides (apis/api, services/service).
const fold = (w) => (w.length >= 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const wordsOf = (text) => (String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(fold);

/** JD keywords: folded word -> the JD's own spelling (first seen), minus stopwords, numbers and words of `exclude`. */
function jdKeywords(jdText, exclude) {
  const out = new Map();
  for (const raw of String(jdText ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const w = fold(raw);
    if (raw.length < 3 || /^\d+$/.test(raw) || STOPWORDS.has(raw) || STOPWORDS.has(w) || exclude.has(w) || out.has(w)) continue;
    out.set(w, raw);
  }
  return out;
}

const round2 = (n) => Math.round(n * 100) / 100;

// Deterministic, no AI. Each JD skill (upstream skill vocabulary) a project
// shows scores by where it appears: title 3, tags 2, anywhere else in the
// block (labeled sections, paragraphs, bullets) 1. A tag outside the
// vocabulary that the JD names literally scores the same way (title 3 when
// the title also names it, else 2). Every other JD word the project uses adds
// KEYWORD_WEIGHT at the same place weights, scaled by its rarity across the
// projects. Ties go to the project matching more distinct terms, then to
// library order.
export function rankProjects(entries, { jdText, cvText = '' }) {
  const jdSkills = extractSkills(jdText);
  const cvSkills = extractSkills(cvText);
  // A project is in cv.md only when its Projects section lists it, not when a role or a skill category shares its name.
  const cvProjects = projectSections(cvText);
  const candidates = [];
  const excluded = [];
  const skillsOf = new Map();
  const projects = entries.filter((e) => {
    if (e.kind === 'project') return true;
    excluded.push({ id: e.id, title: e.title, kind: e.kind });
    return false;
  });
  const bodyOf = (e) => [e.tagline ?? '', e.body ?? e.bullets.join('\n')].join('\n');
  const vocabWords = new Set([...jdSkills].flatMap(wordsOf));
  const words = new Map(projects.map((e) => [e.id, { title: new Set(wordsOf(e.title)), tags: new Set(wordsOf(e.tags.join(' '))), body: new Set(wordsOf(bodyOf(e))) }]));
  const scored = projects.map((e) => {
    const where = {
      title: extractSkills(e.title),
      tags: extractSkills(e.tags.join(', ')),
      body: extractSkills(bodyOf(e)),
    };
    skillsOf.set(e.id, new Set([...where.title, ...where.tags, ...where.body]));
    const matched = new Map();
    for (const skill of jdSkills) {
      const field = ['title', 'tags', 'body'].find((f) => where[f].has(skill));
      if (field) matched.set(skill, WEIGHT[field]);
    }
    const seenTags = new Set();
    const tagWords = new Set();
    for (const tag of e.tags) {
      const key = titleKey(tag);
      if (!key || seenTags.has(key)) continue;
      seenTags.add(key);
      if (extractSkills(tag).size || !mentions(jdText, tag)) continue;
      matched.set(tag, mentions(e.title, tag) ? WEIGHT.title : WEIGHT.tags);
      for (const w of wordsOf(tag)) tagWords.add(w);
    }
    return { e, matched, tagWords };
  });
  const df = new Map();
  for (const { e } of scored) {
    const w = words.get(e.id);
    for (const word of new Set([...w.title, ...w.tags, ...w.body])) df.set(word, (df.get(word) ?? 0) + 1);
  }
  for (const { e, matched, tagWords } of scored) {
    const w = words.get(e.id);
    for (const [word, spelling] of jdKeywords(jdText, new Set([...vocabWords, ...tagWords]))) {
      const field = ['title', 'tags', 'body'].find((f) => w[f].has(word));
      if (!field || matched.has(spelling)) continue;
      matched.set(spelling, KEYWORD_WEIGHT * WEIGHT[field] * Math.log(1 + projects.length / df.get(word)));
    }
    candidates.push({
      id: e.id,
      title: e.title,
      url: e.url ?? null,
      kind: e.kind,
      inCv: findCvEntry(cvProjects, e.title) !== null,
      score: round2([...matched.values()].reduce((a, b) => a + b, 0)),
      matchedSkills: [...matched.keys()].sort(byCodepoint),
      bullets: [...e.bullets],
    });
  }
  const libraryOrder = candidates.map((c) => c.id);
  candidates.sort((a, b) => b.score - a.score || b.matchedSkills.length - a.matchedSkills.length);
  const ranked = candidates.filter((c) => c.score > 0);
  const top = ranked[0]?.score ?? 0;
  const recommended = ranked
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

const DIFF_CONTEXT = 3;
// Per side, after trimming the common prefix and suffix: bounds the LCS table
// at about a million cells however long the two texts are.
const DIFF_MAX_WORDS = 1000;

// Word-level diff in git's plain word-diff style ([-old-]{+new+}), showing
// changed words with a few words of context. null when the words are equal.
export function wordDiff(oldText, newText) {
  const words = (s) => String(s ?? '').replace(/\*\*/g, '').split(/\s+/).filter(Boolean);
  const a = words(oldText);
  const b = words(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  let x = a.slice(pre, a.length - suf);
  let y = b.slice(pre, b.length - suf);
  const truncated = x.length > DIFF_MAX_WORDS || y.length > DIFF_MAX_WORDS;
  if (truncated) {
    x = x.slice(0, DIFF_MAX_WORDS);
    y = y.slice(0, DIFF_MAX_WORDS);
  }
  const w = y.length + 1;
  const lcs = new Uint16Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const ops = a.slice(0, pre).map((word) => ({ t: '=', w: word }));
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { ops.push({ t: '=', w: x[i] }); i++; j++; }
    else if (j < y.length && (i === x.length || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) ops.push({ t: '+', w: y[j++] });
    else ops.push({ t: '-', w: x[i++] });
  }
  if (!truncated) for (const word of a.slice(a.length - suf)) ops.push({ t: '=', w: word });
  if (ops.every((o) => o.t === '=')) return null;
  // Group runs of changes so a replacement reads [-old words-]{+new words+}.
  const parts = [];
  for (const o of ops) {
    const last = parts[parts.length - 1];
    if (o.t === '=') parts.push({ eq: o.w });
    else if (last && !('eq' in last)) last[o.t].push(o.w);
    else parts.push({ '-': o.t === '-' ? [o.w] : [], '+': o.t === '+' ? [o.w] : [] });
  }
  const changed = parts.map((p, k) => (!('eq' in p) ? k : -1)).filter((k) => k >= 0);
  const keep = (k) => changed.some((c) => Math.abs(c - k) <= DIFF_CONTEXT);
  const render = (p) => ('eq' in p ? p.eq : `${p['-'].length ? `[-${p['-'].join(' ')}-]` : ''}${p['+'].length ? `{+${p['+'].join(' ')}+}` : ''}`);
  const out = [];
  let gap = false;
  parts.forEach((p, k) => {
    if (keep(k)) {
      if (gap || (k > 0 && !out.length)) out.push('...');
      out.push(render(p));
      gap = false;
    } else if (out.length) {
      gap = true;
    }
  });
  if (gap) out.push('...');
  if (truncated) out.push(`(diff truncated: compared the first ${DIFF_MAX_WORDS} differing words of each text)`);
  return out.join(' ');
}

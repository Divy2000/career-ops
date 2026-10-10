// Pure helpers for the fork CV build: payload checks against cv.md and the
// projects library, payload normalization for the fork template, and the
// fit-to-page loop and PDF page count used by render-pdf.mjs.

import { parseLibrary, findCvBlock, titleKey } from '../projects/lib.mjs';

export const AWARDS_TITLE = 'Recent Achievements';
const PUBLISHER_HOSTS = ['doi.org', 'sciencedirect.com', 'wiley.com', 'arxiv.org'];

const URL_RE = /https?:\/\/[^\s<>()[\]]+/gi;
// Bare links need a path ("github.com/me/repo") so "Node.js" or "e.g." never count.
const BARE_LINK_RE = /(?<![\w@/])(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s<>()[\]]*/gi;
const linksIn = (text) => {
  const full = (text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;]+$/, ''));
  const rest = text.replace(URL_RE, ' ');
  return [...full, ...(rest.match(BARE_LINK_RE) ?? []).map((u) => u.replace(/[.,;]+$/, ''))];
};
const urlKey = (u) => String(u ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/.,;]+$/, '');

// Entries of cv.md's `## Recent Achievements` section: { line, title, urls }.
export function recentAchievements(cvText) {
  const lines = String(cvText ?? '').split('\n').map((l) => l.replace(/\r$/, ''));
  const start = lines.findIndex((l) => /^##(?!#)\s+/.test(l) && titleKey(l.replace(/^##\s+/, '')) === titleKey(AWARDS_TITLE));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length && !/^##(?!#)\s+/.test(lines[i]); i++) {
    const item = lines[i].match(/^[-*]\s+(.*\S)\s*$/);
    if (!item) continue;
    const text = item[1];
    const bold = text.match(/\*\*(.+?)\*\*/);
    const title = (bold ? bold[1] : text.split(/\s+(?:--|\u2014|\u2013)\s+/)[0]).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
    out.push({ line: i + 1, title, urls: linksIn(text) });
  }
  return out;
}

// The body of every cv.md `##` section whose title ends in "Project" or "Projects" ("Projects", "Personal Projects"): the only part of
// cv.md a project may come from, never an employer, a role, another section's title or a skill category.
function projectSections(cvText) {
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

// Same work: equal normalized titles, or the same canonical link. A title that
// is merely part of a paper's title is a different work.
function sameWork(name, url, entry) {
  const a = titleKey(name);
  if (a && a === titleKey(entry.title)) return true;
  return Boolean(url) && entry.urls.some((u) => urlKey(u) === urlKey(url));
}

function publisherHost(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return PUBLISHER_HOSTS.find((h) => host === h || host.endsWith(`.${h}`)) ?? null;
}

// Papers belong in awards[] (Recent Achievements), never in projects[]; every
// project must come from the library (kind project) or cv.md's Projects section, and its link must
// be that source's link (the library wins when both list the project).
export function checkPayload(payload, { cvText = '', libraryText = null } = {}) {
  const errors = [];
  const warnings = [];
  const achievements = recentAchievements(cvText);
  const library = libraryText === null ? [] : parseLibrary(libraryText).entries;
  const cvProjects = projectSections(cvText);
  for (const p of Array.isArray(payload?.projects) ? payload.projects : []) {
    const name = typeof p?.name === 'string' ? p.name.trim() : '';
    if (!name) continue;
    const paper = achievements.find((a) => sameWork(name, p.url, a));
    if (paper) {
      errors.push(`project "${name}" is listed under Recent Achievements in cv.md (line ${paper.line}: "${paper.title}"); put it in awards[], not projects[]`);
    }
    const entry = library.find((e) => titleKey(e.title) === titleKey(name));
    if (entry && entry.kind !== 'project') {
      errors.push(`project "${name}" is a ${entry.kind} in article-digest.md (line ${entry.line}); only kind project can be listed under Projects`);
    }
    const inCv = entry ? null : findCvBlock(cvProjects, name);
    if (!entry && !inCv) {
      errors.push(`project "${name}" is in neither article-digest.md nor cv.md; take projects from node custom/projects/rank.mjs output`);
    }
    const url = typeof p.url === 'string' ? p.url.trim() : '';
    if (url && (entry || inCv)) {
      const source = entry ? 'article-digest.md' : 'cv.md';
      const known = entry ? (entry.url ? [entry.url] : []) : linksIn(inCv.raw);
      if (!known.length) {
        errors.push(`project "${name}" has link ${url} but ${source} has no link for it; a link cannot be invented`);
      } else if (!known.some((k) => urlKey(k) === urlKey(url))) {
        errors.push(`project "${name}" link ${url} does not match ${source} (${known.join(', ')})`);
      }
    }
    const host = p.url ? publisherHost(p.url) : null;
    if (host) warnings.push(`project "${name}" links to a publisher (${host}); if it is a paper, list it under Recent Achievements instead`);
  }
  return { errors, warnings };
}

// The fork template prints a project as a title plus bullets, so a description
// becomes the first bullet; the awards section defaults to Recent Achievements.
export function normalizePayload(payload) {
  const out = structuredClone(payload ?? {});
  if (Array.isArray(out.projects)) {
    out.projects = out.projects.map((p) => {
      if (!p || typeof p !== 'object' || !p.description) return p;
      const { description, ...rest } = p;
      return { ...rest, bullets: [description, ...(Array.isArray(p.bullets) ? p.bullets : [])] };
    });
  }
  out.sections = { ...(out.sections ?? {}) };
  if (!out.sections.awards) out.sections.awards = AWARDS_TITLE;
  return out;
}

// Density levels the fork template defines (html[data-density]), loosest first.
export const DENSITIES = [0, 1, 2, 3];

export function setDensity(html, density) {
  const text = String(html ?? '');
  const tag = text.match(/<html\b[^>]*>/i);
  if (!tag) throw new Error('no <html> tag to set data-density on');
  // Every spelling: any case, whitespace around "=", any quoting, repeats.
  const cleaned = tag[0].replace(/\s+data-density(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?(?=[\s/>])/gi, '');
  const updated = cleaned.replace(/>$/, ` data-density="${density}">`);
  return text.slice(0, tag.index) + updated + text.slice(tag.index + tag[0].length);
}

// Tries each density in turn and stops at the first whose render fits the
// budget. `render(html, density)` resolves to { pages } or throws; a throw
// (fact check, section order, a crash) stops the loop at once.
export async function fitToPages({ html, maxPages, render }) {
  const attempts = [];
  let last = null;
  for (const density of DENSITIES) {
    const candidate = setDensity(html, density);
    const { pages } = await render(candidate, density);
    attempts.push({ density, pages });
    last = { density, pages, html: candidate };
    if (pages <= maxPages) return { ...last, fits: true, attempts };
  }
  return { ...last, fits: false, attempts };
}

// Page count from the catalog's root /Pages dictionary (a port of upstream
// generate-pdf.mjs countRenderedPdfPages, which is not exported). Following the
// catalog reference ignores page-like text inside content streams.
export function countPdfPages(pdfBuffer) {
  const pdf = Buffer.from(pdfBuffer).toString('latin1');
  const objects = new Map();
  for (const m of pdf.matchAll(/(?:^|[\r\n])(\d+)\s+(\d+)\s+obj\b([\s\S]*?)\bendobj\b/g)) {
    const streamAt = m[3].search(/\bstream(?:\r?\n|\r)/);
    objects.set(`${m[1]} ${m[2]}`, streamAt === -1 ? m[3] : m[3].slice(0, streamAt));
  }
  const catalog = [...objects.values()].find((body) => /\/Type\s*\/Catalog\b/.test(body));
  const ref = catalog?.match(/\/Pages\s+(\d+)\s+(\d+)\s+R\b/);
  const pages = ref ? objects.get(`${ref[1]} ${ref[2]}`) : null;
  const count = pages && /\/Type\s*\/Pages\b/.test(pages) ? pages.match(/\/Count\s+(\d+)\b/) : null;
  const n = count ? Number(count[1]) : 0;
  if (!Number.isInteger(n) || n < 1) throw new Error('could not read the page count from the PDF page tree');
  return n;
}

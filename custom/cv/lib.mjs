// Pure helpers for the fork CV build: payload checks against cv.md and the
// projects library, payload normalization for the fork template, and the
// fit-to-page loop and PDF page count used by render-pdf.mjs.

import { parseLibrary, findCvEntry, titleKey } from '../projects/lib.mjs';

export const AWARDS_TITLE = 'Recent Achievements';
const PUBLISHER_HOSTS = ['doi.org', 'sciencedirect.com', 'wiley.com', 'arxiv.org'];
// A shorter name only matches a longer title it is part of when it is at least
// this long, so a short project name cannot collide with a paper title by accident.
const MIN_CONTAINED_KEY = 10;

const URL_RE = /https?:\/\/[^\s<>()[\]]+/gi;
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
    out.push({ line: i + 1, title, urls: (text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;]+$/, '')) });
  }
  return out;
}

function sameWork(name, url, entry) {
  const a = titleKey(name);
  const b = titleKey(entry.title);
  if (a && b) {
    if (a === b) return true;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    if (short.length >= MIN_CONTAINED_KEY && long.includes(short)) return true;
  }
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
// project must come from the library (kind project) or cv.md.
export function checkPayload(payload, { cvText = '', libraryText = null } = {}) {
  const errors = [];
  const warnings = [];
  const achievements = recentAchievements(cvText);
  const library = libraryText === null ? [] : parseLibrary(libraryText).entries;
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
    if (!entry && !findCvEntry(cvText, name)) {
      errors.push(`project "${name}" is in neither article-digest.md nor cv.md; take projects from node custom/projects/rank.mjs output`);
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

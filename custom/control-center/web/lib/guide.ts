import type { KeyTarget } from './tutorials';
import type { GuideBlockView, GuideDocs, GuideDocsSectionView, GuideSubsectionView } from '@shared/api';

export interface FlatSub {
  sectionId: string;
  subId: string;
  /** Unique across the guide; a subsection id is only unique inside its section. */
  key: string;
}

export const subKey = (sectionId: string, subId: string) => `${sectionId}/${subId}`;

export function flattenSubsections(docs: GuideDocs): FlatSub[] {
  return docs.sections.flatMap((s) => s.subsections.map((u) => ({ sectionId: s.id, subId: u.id, key: subKey(s.id, u.id) })));
}

/** The search params of a link to a place in the guide (the route's own shape, so a link can be built for any location). */
export interface GuideSearchParams {
  t?: string;
  view: 'guide';
  section: string;
  sub?: string;
}

export interface GuideLocation {
  sectionId: string;
  /** Null: the top of the section (a link that names only a section, such as every version 1 link). */
  subId: string | null;
}

/** Where `?section=&sub=` points. Unknown ids never fail: they fall back to the section, then to the first section. */
export function resolveLocation(docs: GuideDocs, section: string | undefined, sub: string | undefined): GuideLocation {
  const named = docs.sections.find((s) => s.id === section);
  if (named) return { sectionId: named.id, subId: sub !== undefined && named.subsections.some((u) => u.id === sub) ? sub : null };
  const owner = sub === undefined ? undefined : docs.sections.find((s) => s.subsections.some((u) => u.id === sub));
  if (owner) return { sectionId: owner.id, subId: sub ?? null };
  return { sectionId: docs.sections[0]?.id ?? '', subId: null };
}

/** The subsection one step from `current` in reading order, across sections; null at either end. From a section's top, next is its first subsection. */
export function stepSubsection(docs: GuideDocs, current: GuideLocation, delta: 1 | -1): { sectionId: string; subId: string } | null {
  const flat = flattenSubsections(docs);
  const exact = current.subId === null ? -1 : flat.findIndex((f) => f.sectionId === current.sectionId && f.subId === current.subId);
  let target: FlatSub | undefined;
  if (exact !== -1) target = flat[exact + delta];
  else {
    // Not on a subsection: the position is just before the first one of the section.
    const first = flat.findIndex((f) => f.sectionId === current.sectionId);
    target = first === -1 ? (delta === 1 ? flat[0] : undefined) : flat[delta === 1 ? first : first - 1];
  }
  return target ? { sectionId: target.sectionId, subId: target.subId } : null;
}

export interface Progress {
  done: number;
  total: number;
}

export function sectionProgress(section: GuideDocsSectionView, reviewed: ReadonlySet<string>): Progress {
  return { done: section.subsections.filter((u) => reviewed.has(subKey(section.id, u.id))).length, total: section.subsections.length };
}

export function totalProgress(docs: GuideDocs, reviewed: ReadonlySet<string>): Progress {
  const flat = flattenSubsections(docs);
  return { done: flat.filter((f) => reviewed.has(f.key)).length, total: flat.length };
}

/** Marks for subsections that were removed from the guide since they were stored are dropped. */
export function pruneReviewed(docs: GuideDocs, keys: Iterable<string>): Set<string> {
  const known = new Set(flattenSubsections(docs).map((f) => f.key));
  return new Set([...keys].filter((k) => known.has(k)));
}

export const REVIEWED_PREFIX = 'cc.guide.v2.';

/** The subsection keys marked reviewed in this browser. Storage can be blocked or hold anything, so this never throws. */
export function readReviewed(tutorialId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(REVIEWED_PREFIX + tutorialId) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const LEGACY_REVIEWED_PREFIX = 'cc.tutorials.guide.reviewed.';

const parseKeys = (raw: string | null): string[] => {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/**
 * The marks to start from. A tutorial that has never had version 2 marks and whose guide is an adapted version 1 guide inherits the marks
 * of the old per-section guide once: an adapted section holds one subsection with the same id, so `today` becomes `today/today`.
 * The old key is left alone; once the new key exists it is the only one read.
 */
export function loadReviewed(tutorialId: string, docs: GuideDocs): Set<string> {
  let stored: string | null;
  try {
    stored = window.localStorage.getItem(REVIEWED_PREFIX + tutorialId);
    if (stored === null && docs.legacy) {
      const carried = [...pruneReviewed(docs, parseKeys(window.localStorage.getItem(LEGACY_REVIEWED_PREFIX + tutorialId)).map((id) => subKey(id, id)))];
      if (carried.length > 0) writeReviewed(tutorialId, carried);
      return new Set(carried);
    }
  } catch {
    return new Set();
  }
  return pruneReviewed(docs, parseKeys(stored));
}

export function writeReviewed(tutorialId: string, keys: string[]): void {
  try {
    window.localStorage.setItem(REVIEWED_PREFIX + tutorialId, JSON.stringify(keys));
  } catch {
    /* a blocked store only means the marks are not remembered after a reload */
  }
}

export type SearchField = 'title' | 'summary' | 'text' | 'steps' | 'tips' | 'caption';

export interface SearchHit {
  sectionId: string;
  sectionTitle: string;
  /** Null for a hit on the section's own title or summary. */
  subId: string | null;
  subTitle: string | null;
  field: SearchField;
  excerpt: string;
}

export interface SearchGroup {
  sectionId: string;
  title: string;
  hits: SearchHit[];
}

export interface SearchResult {
  groups: SearchGroup[];
  total: number;
}

const MIN_SEARCH_LENGTH = 2;
const EXCERPT_LENGTH = 160;

export const searchTerms = (term: string): string[] => term.toLowerCase().split(/\s+/).filter(Boolean);
export const isSearching = (term: string): boolean => term.trim().length >= MIN_SEARCH_LENGTH;

interface Entry {
  field: SearchField;
  text: string;
}

const blockEntries = (b: GuideBlockView): Entry[] => {
  switch (b.type) {
    case 'text':
      return [{ field: 'text', text: b.text }];
    case 'steps':
      return b.items.map((text) => ({ field: 'steps', text }));
    case 'tips':
      return b.items.map((text) => ({ field: 'tips', text }));
    case 'media':
      return b.caption ? [{ field: 'caption', text: b.caption }] : [];
  }
};

// The short label is the name the reader sees in the contents, so it counts as a title.
const titleEntries = (unit: { title: string; short: string }): Entry[] => [{ field: 'title', text: unit.title }, ...(unit.short !== unit.title ? [{ field: 'title' as const, text: unit.short }] : [])];

const subEntries = (u: GuideSubsectionView): Entry[] => [...titleEntries(u), ...(u.summary ? [{ field: 'summary' as const, text: u.summary }] : []), ...u.blocks.flatMap(blockEntries)];

/** Every word must occur somewhere in the unit; the excerpt comes from the entry that holds the most distinct words. */
function match(entries: Entry[], terms: string[]): Entry | null {
  const all = entries.map((e) => e.text.toLowerCase()).join('\n');
  if (!terms.every((t) => all.includes(t))) return null;
  let best: Entry | null = null;
  let bestCount = 0;
  for (const e of entries) {
    const lower = e.text.toLowerCase();
    const count = terms.filter((t) => lower.includes(t)).length;
    if (count > bestCount) {
      best = e;
      bestCount = count;
    }
  }
  return best;
}

/** A title match is already the result's headline, so the line under it is the summary, else the first text block, else the title again. */
function titleExcerpt(summary: string, blocks: GuideBlockView[], title: string): string {
  if (summary) return summary;
  const text = blocks.find((b) => b.type === 'text');
  return text?.type === 'text' ? text.text : title;
}

export function searchGuide(docs: GuideDocs, term: string): SearchResult {
  const terms = isSearching(term) ? searchTerms(term) : [];
  if (terms.length === 0) return { groups: [], total: 0 };
  const groups: SearchGroup[] = [];
  let total = 0;
  for (const s of docs.sections) {
    const hits: SearchHit[] = [];
    const own = match([...titleEntries(s), { field: 'summary', text: s.summary }], terms);
    if (own) {
      const text = own.field === 'title' ? titleExcerpt(s.summary, [], s.title) : own.text;
      hits.push({ sectionId: s.id, sectionTitle: s.title, subId: null, subTitle: null, field: own.field, excerpt: excerptAround(text, terms) });
    }
    for (const u of s.subsections) {
      const found = match(subEntries(u), terms);
      if (!found) continue;
      const text = found.field === 'title' ? titleExcerpt(u.summary, u.blocks, u.title) : found.text;
      hits.push({ sectionId: s.id, sectionTitle: s.title, subId: u.id, subTitle: u.title, field: found.field, excerpt: excerptAround(text, terms) });
    }
    if (hits.length > 0) {
      groups.push({ sectionId: s.id, title: s.title, hits });
      total += hits.length;
    }
  }
  return { groups, total };
}

/** About `max` characters of `text` around the first match, cut between words, with "..." where text was cut. */
export function excerptAround(text: string, terms: string[], max = EXCERPT_LENGTH): string {
  if (text.length <= max) return text;
  const lower = text.toLowerCase();
  const at = terms.map((t) => lower.indexOf(t)).filter((i) => i !== -1).sort((a, b) => a - b)[0];
  if (at === undefined) return `${text.slice(0, max).replace(/\s+\S*$/, '')}...`;
  let start = Math.max(0, Math.min(at - Math.floor(max / 3), text.length - max));
  let end = Math.min(text.length, start + max);
  if (start > 0) {
    // Begin at the next whole word, unless that would drop the match itself.
    const space = text.indexOf(' ', start);
    if (space !== -1 && space + 1 <= at) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > at) end = space;
  }
  return `${start > 0 ? '...' : ''}${text.slice(start, end).trim()}${end < text.length ? '...' : ''}`;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface Piece {
  text: string;
  mark: boolean;
}

/** Splits `text` into plain and matched pieces, so a renderer can wrap the matches in <mark> without injecting HTML. */
export function highlight(text: string, terms: string[]): Piece[] {
  if (text === '') return [];
  const live = terms.filter(Boolean);
  if (live.length === 0) return [{ text, mark: false }];
  const pattern = new RegExp(`(${[...live].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})`, 'gi');
  // With one capture group, split puts the matches at the odd positions.
  return text
    .split(pattern)
    .map((piece, i) => ({ text: piece, mark: i % 2 === 1 }))
    .filter((p) => p.text !== '');
}

export type HeadingStatus = 'above' | 'in' | 'below';

export interface SpyState {
  /** Subsection heading ids in reading order. */
  order: string[];
  /** Where each heading last reported itself relative to the reading band at the top of the page. */
  status: Record<string, HeadingStatus>;
  active: string | null;
}

export interface SpyEntry {
  id: string;
  intersecting: boolean;
  /** For a heading outside the band: whether it is above (scrolled past) or below (not reached yet). */
  above: boolean;
}

export const spyInitial = (order: string[]): SpyState => ({ order, status: {}, active: null });

/**
 * The heading being read: the first one inside the reading band; otherwise the last one scrolled past; otherwise,
 * when every heading reported is still ahead, the one before the first of them (the first heading at the top of a section).
 */
export function spyReduce(state: SpyState, entries: SpyEntry[]): SpyState {
  const status = { ...state.status };
  for (const e of entries) if (state.order.includes(e.id)) status[e.id] = e.intersecting ? 'in' : e.above ? 'above' : 'below';
  const reported = state.order.filter((id) => status[id] !== undefined);
  if (reported.length === 0) return { ...state, status };
  const inBand = reported.find((id) => status[id] === 'in');
  const passed = reported.filter((id) => status[id] === 'above').at(-1);
  const firstAhead = reported.find((id) => status[id] === 'below');
  const active = inBand ?? passed ?? (firstAhead === undefined ? state.active : (state.order[Math.max(0, state.order.indexOf(firstAhead) - 1)] ?? state.active));
  return { ...state, status, active };
}

export type GuideKeyAction = 'next' | 'prev' | 'search';

/** What a key press means in the guide. `target` is the kind of element that has focus. */
export function guideKeyAction(e: { key: string; target: KeyTarget; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): GuideKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.target === 'input' || e.target === 'textarea' || e.target === 'select' || e.target === 'editable') return null;
  switch (e.key) {
    case 'j':
    case 'J':
      return 'next';
    case 'k':
    case 'K':
      return 'prev';
    case '/':
      return 'search';
    default:
      return null;
  }
}

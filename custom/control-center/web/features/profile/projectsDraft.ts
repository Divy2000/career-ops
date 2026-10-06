// Form state for one projects-library entry and its conversion to the API body.
import type { ProjectInput, ProjectKind, ProjectView } from '@shared/api';

export interface ProjectDraft {
  title: string;
  url: string;
  /** Comma-separated, as typed. */
  tags: string;
  kind: ProjectKind;
  dates: string;
  bullets: string[];
}

export const KIND_OPTIONS: Array<{ value: ProjectKind; label: string }> = [
  { value: 'project', label: 'Project' },
  { value: 'publication', label: 'Publication' },
  { value: 'article', label: 'Article' },
];

export const emptyDraft = (): ProjectDraft => ({ title: '', url: '', tags: '', kind: 'project', dates: '', bullets: [''] });

export function draftFromEntry(e: ProjectView): ProjectDraft {
  const kind = KIND_OPTIONS.some((k) => k.value === e.kind) ? (e.kind as ProjectKind) : 'project';
  return { title: e.title, url: e.url ?? '', tags: e.tags.join(', '), kind, dates: e.dates ?? '', bullets: e.bullets.length ? [...e.bullets] : [''] };
}

/** Fields the form does not edit; pass the entry's own so an edit keeps its tagline and provenance. */
export interface KeptFields {
  tagline?: string | null;
  source?: string | null;
}

export function entryFromDraft(d: ProjectDraft, kept: KeptFields = {}): ProjectInput {
  return {
    title: d.title.trim(),
    url: d.url.trim() || null,
    tagline: kept.tagline ?? null,
    source: kept.source ?? null,
    tags: d.tags.split(',').map((t) => t.trim()).filter(Boolean),
    kind: d.kind,
    dates: d.dates.trim() || null,
    bullets: d.bullets.map((b) => b.trim()).filter(Boolean),
  };
}

const LIMITS = { title: 300, url: 2048, tags: 30, tag: 60, dates: 100, bullets: 20, bullet: 2000 };

/** Checks worth catching before a round trip; the server validates the whole library again. */
export function draftProblems(d: ProjectDraft): string[] {
  const input = entryFromDraft(d);
  const problems: string[] = [];
  if (!input.title) problems.push('Add a title.');
  if (input.url && !/^https?:\/\/\S+$/i.test(input.url)) problems.push('The link must start with http:// or https://.');
  if (input.kind === 'project' && input.bullets.length === 0) problems.push('Add at least one bullet.');
  // The library's limits (entrySchema in server/routes/projects.ts); tags and bullets numbered as the form labels them.
  if (input.title.length > LIMITS.title) problems.push(`The title is longer than ${LIMITS.title} characters.`);
  if (input.url && input.url.length > LIMITS.url) problems.push(`The link is longer than ${LIMITS.url} characters.`);
  const tags = input.tags ?? [];
  if (tags.length > LIMITS.tags) problems.push(`Use at most ${LIMITS.tags} tags.`);
  tags.forEach((t, i) => {
    if (t.length > LIMITS.tag) problems.push(`Tag ${i + 1} is longer than ${LIMITS.tag} characters.`);
  });
  if (input.dates && input.dates.length > LIMITS.dates) problems.push(`The dates are longer than ${LIMITS.dates} characters.`);
  if (input.bullets.length > LIMITS.bullets) problems.push(`Use at most ${LIMITS.bullets} bullets.`);
  // The library stores one bullet per line; numbered as the form labels them ("Bullet 1").
  d.bullets.forEach((b, i) => {
    if (/[\r\n]/.test(b.trim())) problems.push(`Bullet ${i + 1} spans more than one line; give each point its own bullet.`);
    if (b.trim().length > LIMITS.bullet) problems.push(`Bullet ${i + 1} is longer than ${LIMITS.bullet} characters.`);
  });
  return problems;
}

/** The fields of a 400 the server sent anyway (its zod issues), named as the form labels them. */
export function describeIssues(issues: Array<{ path: Array<string | number>; message: string }> | undefined): string[] {
  const label = ([field, index]: Array<string | number>) =>
    field === 'title' ? 'Title' : field === 'tags' && typeof index === 'number' ? `Tag ${index + 1}` : field === 'bullets' && typeof index === 'number' ? `Bullet ${index + 1}` : String(field);
  return (issues ?? []).map((i) => `${label(i.path)}: ${i.message}`);
}

const DRAFT_FIELDS = ['title', 'url', 'tags', 'kind', 'dates', 'bullets'] as const;
export type DraftField = (typeof DRAFT_FIELDS)[number];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * After a 409: the draft rebased on the entry as it is now on disk. A field the user did not change takes the version
 * on disk, so a second save never quietly undoes another writer's edit; a field both sides changed keeps the user's
 * value and is named in `conflicts`.
 */
export function rebaseDraft(base: ProjectDraft, draft: ProjectDraft, current: ProjectDraft): { draft: ProjectDraft; conflicts: DraftField[] } {
  const next = { ...draft };
  const conflicts: DraftField[] = [];
  for (const f of DRAFT_FIELDS) {
    if (same(draft[f], base[f])) Object.assign(next, { [f]: current[f] });
    else if (!same(current[f], base[f]) && !same(current[f], draft[f])) conflicts.push(f);
  }
  return { draft: next, conflicts };
}

/** Where the edited entry was when its form opened: what lets a conflict tell a rename on disk from a removal. */
export interface EntryOrigin {
  ids: string[];
  index: number;
  bullets: string[];
}

/**
 * After a 409 whose fresh library has no entry with the form's id: the entry another writer renamed (ids come from
 * titles), or null when it cannot be told apart from a removal. A new id carrying the entry's bullets is it, if only
 * one does; so is a new id at the entry's position, when the library kept its size and it shares a bullet with the
 * entry (a removal plus an unrelated addition shares nothing). An entry with no bullets is never matched.
 */
export function findRenamed<E extends { id: string; bullets: string[] }>(origin: EntryOrigin, entries: E[]): E | null {
  // An entry with no bullets (an article, a publication) leaves nothing to recognize it by.
  if (origin.bullets.length === 0) return null;
  const added = entries.filter((e) => !origin.ids.includes(e.id));
  const sameBullets = added.filter((e) => same(e.bullets, origin.bullets));
  if (sameBullets.length === 1) return sameBullets[0]!;
  if (sameBullets.length > 1) return null;
  const atIndex = entries[origin.index];
  const sharesBullet = (x: E) => x.bullets.some((b) => origin.bullets.includes(b));
  return entries.length === origin.ids.length && atIndex && added.includes(atIndex) && sharesBullet(atIndex) ? atIndex : null;
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

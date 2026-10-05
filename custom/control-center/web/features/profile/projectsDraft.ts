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

/** Checks worth catching before a round trip; the server validates the whole library again. */
export function draftProblems(d: ProjectDraft): string[] {
  const input = entryFromDraft(d);
  const problems: string[] = [];
  if (!input.title) problems.push('Add a title.');
  if (input.url && !/^https?:\/\/\S+$/i.test(input.url)) problems.push('The link must start with http:// or https://.');
  if (input.kind === 'project' && input.bullets.length === 0) problems.push('Add at least one bullet.');
  // The library stores one bullet per line; numbered as the form labels them ("Bullet 1").
  d.bullets.forEach((b, i) => {
    if (/[\r\n]/.test(b.trim())) problems.push(`Bullet ${i + 1} spans more than one line; give each point its own bullet.`);
  });
  return problems;
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

import type { KeyTarget } from './tutorials';

interface Searchable {
  id: string;
  title: string;
  summary: string;
  steps: string[];
}

/** The sections whose title, summary or steps contain `term` (case-insensitive); every section for a blank term. */
export function filterSections<T extends Searchable>(sections: T[], term: string): T[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return sections;
  return sections.filter((s) => [s.title, s.summary, ...s.steps].some((text) => text.toLowerCase().includes(needle)));
}

/** The id one step away from `currentId` in `sections`, or null when there is nowhere to go. A current section that is not listed steps to the first. */
export function stepSection(sections: Array<{ id: string }>, currentId: string | undefined, delta: 1 | -1): string | null {
  const at = sections.findIndex((s) => s.id === currentId);
  const target = at === -1 ? (delta === 1 ? 0 : -1) : at + delta;
  const next = sections[target];
  return next && next.id !== currentId ? next.id : null;
}

export function countReviewed(sections: Array<{ id: string }>, reviewed: ReadonlySet<string>): number {
  return sections.filter((s) => reviewed.has(s.id)).length;
}

export type GuideKeyAction = 'next' | 'prev';

/** What a key press means in the Quick guide. `target` is the kind of element that has focus. */
export function guideKeyAction(e: { key: string; target: KeyTarget; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): GuideKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.target === 'input' || e.target === 'textarea' || e.target === 'select' || e.target === 'editable') return null;
  switch (e.key) {
    case 'j':
    case 'J':
    case 'ArrowDown':
      return 'next';
    case 'k':
    case 'K':
    case 'ArrowUp':
      return 'prev';
    default:
      return null;
  }
}

const reviewedKey = (tutorialId: string) => `cc.tutorials.guide.reviewed.${tutorialId}`;

/** The section ids marked reviewed in this browser. Storage can be blocked or hold anything, so this never throws. */
export function readReviewed(tutorialId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(reviewedKey(tutorialId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function writeReviewed(tutorialId: string, ids: string[]): void {
  try {
    window.localStorage.setItem(reviewedKey(tutorialId), JSON.stringify(ids));
  } catch {
    /* a blocked store only means the marks are not remembered after a reload */
  }
}

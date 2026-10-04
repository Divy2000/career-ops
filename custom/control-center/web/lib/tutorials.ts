export interface Chapter {
  title: string;
  start: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `m:ss`, or `h:mm:ss` from one hour. */
export function formatTimestamp(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

// A seek to a chapter start can land a few milliseconds early; that still counts as being in the chapter.
const EPSILON = 0.01;

/** Index of the chapter playing at `time` (chapters sorted by start), or -1 before the first one. */
export function chapterIndexAt(chapters: Chapter[], time: number): number {
  let index = -1;
  for (const [i, c] of chapters.entries()) if (c.start <= time + EPSILON) index = i;
  return index;
}

/** Keeps the paragraphs that contain `term`, each under the heading it belongs to. Authoring comments never match. */
export function filterTranscript(md: string, term: string): { text: string; matches: number | null } {
  const needle = term.trim().toLowerCase();
  if (!needle) return { text: md, matches: null };
  const kept: string[] = [];
  let heading: string | null = null;
  let headingKept = false;
  let matches = 0;
  for (const block of md.replace(/<!--[\s\S]*?-->/g, '').split(/\n{2,}/)) {
    const text = block.trim();
    if (!text) continue;
    const isHeading = /^#{1,6}\s/.test(text);
    if (isHeading) {
      heading = text;
      headingKept = false;
    }
    if (!text.toLowerCase().includes(needle)) continue;
    matches++;
    if (heading !== null && !headingKept) {
      kept.push(heading);
      headingKept = true;
    }
    if (!isHeading) kept.push(text);
  }
  return { text: kept.join('\n\n'), matches };
}

export type KeyAction = 'toggle' | 'back' | 'forward' | 'captions' | 'prevChapter' | 'nextChapter';
export type KeyTarget = 'input' | 'textarea' | 'select' | 'editable' | 'button' | 'link' | 'body' | string;

/** What a key press means on the player page. `target` is the kind of element that has focus. */
export function keyAction(e: { key: string; target: KeyTarget; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): KeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.target === 'input' || e.target === 'textarea' || e.target === 'select' || e.target === 'editable') return null;
  switch (e.key) {
    case ' ':
      return e.target === 'button' || e.target === 'link' ? null : 'toggle';
    case 'k':
    case 'K':
      return 'toggle';
    case 'j':
    case 'J':
      return 'back';
    case 'l':
    case 'L':
      return 'forward';
    case 'c':
    case 'C':
      return 'captions';
    case 'ArrowUp':
      return 'prevChapter';
    case 'ArrowDown':
      return 'nextChapter';
    default:
      return null;
  }
}

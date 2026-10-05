/**
 * How far each part of a tutorial has been watched, in this browser only. Storage can be blocked or hold anything,
 * so every read and write is guarded and a bad entry is dropped rather than trusted.
 */
export interface PartProgress {
  /** Where the viewer last was, in seconds. */
  at: number;
  /** The furthest point reached, in seconds. */
  max: number;
  /** Watched to the end (or to within DONE_MARGIN of it); stays true after seeking back. */
  done: boolean;
}

export type TutorialProgress = Record<string, PartProgress>;

export const PROGRESS_PREFIX = 'cc.tutorials.progress.v1.';
/** A part counts as watched this close to its end: the last seconds are often a title card or silence. */
const DONE_MARGIN = 3;
/** No resume this early in a part: starting over costs less than a jump. */
const RESUME_MIN = 5;
/** No resume this close to the end: the viewer would land on the closing seconds. */
const RESUME_TAIL = 10;
const SAVE_EVERY_MS = 5_000;

const seconds = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const knownLength = (d: number | null): d is number => d !== null && Number.isFinite(d) && d > 0;

function trusted(value: unknown): PartProgress | null {
  if (value === null || typeof value !== 'object') return null;
  const { at, max, done } = value as Record<string, unknown>;
  return seconds(at) && seconds(max) && typeof done === 'boolean' ? { at, max, done } : null;
}

export function readProgress(tutorialId: string): TutorialProgress {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(PROGRESS_PREFIX + tutorialId) ?? '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: TutorialProgress = {};
    for (const [part, value] of Object.entries(parsed)) {
      const p = trusted(value);
      if (p) out[part] = p;
    }
    return out;
  } catch {
    return {};
  }
}

export function savePartProgress(tutorialId: string, partId: string, progress: PartProgress): void {
  try {
    window.localStorage.setItem(PROGRESS_PREFIX + tutorialId, JSON.stringify({ ...readProgress(tutorialId), [partId]: progress }));
  } catch {
    /* a blocked store only means the progress is not remembered after a reload */
  }
}

/** The progress after the playhead reached `time` in a part of `duration` seconds. */
export function advance(prev: PartProgress | undefined, time: number, duration: number | null): PartProgress {
  const finished = knownLength(duration) && time >= duration - DONE_MARGIN;
  return { at: time, max: Math.max(prev?.max ?? 0, time), done: (prev?.done ?? false) || finished };
}

/** Where to pick a part up again, or null to start it from the beginning. */
export function resumePoint(progress: PartProgress | undefined, duration: number | null): number | null {
  if (!progress || progress.done || !knownLength(duration)) return null;
  return progress.at > RESUME_MIN && progress.at < duration - RESUME_TAIL ? progress.at : null;
}

/** How much of a part has been watched, from 0 to 1, for its progress track. */
export function watchedFraction(progress: PartProgress | undefined, duration: number | null): number {
  if (progress?.done) return 1;
  if (!progress || !knownLength(duration)) return 0;
  return Math.min(1, progress.max / duration);
}

export interface ProgressTracker {
  /** While playing: writes at most every few seconds. */
  tick(time: number, duration: number | null): void;
  /** On pause, end and unmount: writes now. */
  save(time: number, duration: number | null): void;
}

export function createProgressTracker(tutorialId: string, partId: string, opts: { now?: () => number; onSave?: (p: PartProgress) => void } = {}): ProgressTracker {
  const now = opts.now ?? Date.now;
  let current = readProgress(tutorialId)[partId];
  let lastWrite = Number.NEGATIVE_INFINITY;
  const write = (time: number, duration: number | null) => {
    current = advance(current, time, duration);
    lastWrite = now();
    savePartProgress(tutorialId, partId, current);
    opts.onSave?.(current);
  };
  return {
    tick(time, duration) {
      if (now() - lastWrite >= SAVE_EVERY_MS) write(time, duration);
      else current = advance(current, time, duration);
    },
    save: write,
  };
}

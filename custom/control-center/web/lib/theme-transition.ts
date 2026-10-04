import { flushSync } from 'react-dom';

/** reveal: a user choice, growing from the control. fade: the OS flipped under Auto. none: another tab changed it. */
export type ThemeChangeKind = 'reveal' | 'fade' | 'none';
export type RevealOrigin = Element | { x: number; y: number } | undefined;

const REVEAL_MS = 520;
const FADE_MS = 200;
const REVEAL_EASING = 'cubic-bezier(0.65, 0, 0.35, 1)';
const FADING = 'theme-fading';

/** Distance from (x, y) to the farthest viewport corner: the circle radius that covers the screen. */
export function revealRadius(x: number, y: number, width: number, height: number): number {
  return Math.hypot(Math.max(x, width - x), Math.max(y, height - y));
}

export function originPoint(origin: RevealOrigin, viewport: { width: number; height: number }): { x: number; y: number } {
  if (!origin) return { x: viewport.width / 2, y: viewport.height / 2 };
  if (origin instanceof Element) {
    const r = origin.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return origin;
}

const prefersReducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let fadeTimer = 0;
/** An instant or reveal change must not inherit a fade started a moment earlier: its timer would still be running. */
function cancelFade(): void {
  window.clearTimeout(fadeTimer);
  document.documentElement.classList.remove(FADING);
}

/** CSS transitions on color-ish properties for one beat (see theme.css/motion.css); overlapping fades extend the same window. */
function fade(commit: () => void): void {
  const root = document.documentElement;
  root.classList.add(FADING);
  commit();
  window.clearTimeout(fadeTimer);
  fadeTimer = window.setTimeout(() => root.classList.remove(FADING), FADE_MS + 20);
}

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => { ready: Promise<void> } };

/**
 * Runs `commit` (the state change plus its DOM update) with the right amount of motion. Reduced motion and
 * cross-tab changes are instant. A user choice reveals the new theme as a circle growing from the clicked
 * control via the View Transitions API; without it, and for OS-driven flips, the colors cross-fade instead.
 */
export function runThemeChange(commit: () => void, kind: ThemeChangeKind, origin?: RevealOrigin): void {
  if (kind === 'none' || prefersReducedMotion()) {
    cancelFade();
    return commit();
  }
  const doc = document as ViewTransitionDocument;
  if (kind === 'fade' || typeof doc.startViewTransition !== 'function') return fade(commit);
  cancelFade();
  const { x, y } = originPoint(origin, { width: window.innerWidth, height: window.innerHeight });
  const radius = revealRadius(x, y, window.innerWidth, window.innerHeight);
  // The callback must leave the DOM fully updated, React included, before the browser snapshots the new state.
  const transition = doc.startViewTransition(() => flushSync(commit));
  transition.ready.then(
    () => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: REVEAL_MS, easing: REVEAL_EASING, pseudoElement: '::view-transition-new(root)' },
      );
    },
    () => {
      // The browser skipped the transition (hidden tab, a newer transition): the commit already ran, so there is nothing to animate.
    },
  );
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { originPoint, revealRadius, runThemeChange } from '@web/lib/theme-transition';

type Vt = { ready: Promise<void>; finished: Promise<void> };

function stubMotion(opts: { reduced?: boolean; viewTransitions?: boolean } = {}) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('prefers-reduced-motion') ? Boolean(opts.reduced) : false, media: q, addEventListener() {}, removeEventListener() {} }));
  const animate = vi.fn();
  (document.documentElement as unknown as { animate: unknown }).animate = animate;
  const calls: Array<() => void> = [];
  if (opts.viewTransitions) {
    (document as unknown as { startViewTransition: unknown }).startViewTransition = vi.fn((cb: () => void) => {
      calls.push(cb);
      cb();
      return { ready: Promise.resolve(), finished: Promise.resolve() } satisfies Vt;
    });
  } else {
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  }
  return { animate, startViewTransition: (document as unknown as { startViewTransition?: ReturnType<typeof vi.fn> }).startViewTransition, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.className = '';
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
});

describe('revealRadius', () => {
  it('is the distance from the origin to the farthest viewport corner', () => {
    expect(revealRadius(0, 0, 300, 400)).toBe(500);
    expect(revealRadius(300, 400, 300, 400)).toBe(500);
    expect(revealRadius(150, 200, 300, 400)).toBeCloseTo(250);
  });
});

describe('originPoint', () => {
  it('uses the center of an element', () => {
    const el = document.createElement('button');
    el.getBoundingClientRect = () => ({ x: 100, y: 10, width: 40, height: 20, left: 100, top: 10, right: 140, bottom: 30, toJSON() {} });
    expect(originPoint(el, { width: 1000, height: 800 })).toEqual({ x: 120, y: 20 });
  });
  it('passes a point through and falls back to the viewport center', () => {
    expect(originPoint({ x: 5, y: 6 }, { width: 1000, height: 800 })).toEqual({ x: 5, y: 6 });
    expect(originPoint(undefined, { width: 1000, height: 800 })).toEqual({ x: 500, y: 400 });
  });
});

describe('runThemeChange', () => {
  it('applies instantly, without any animation, for a change from another tab', async () => {
    const m = stubMotion({ viewTransitions: true });
    const commit = vi.fn();
    runThemeChange(commit, 'none');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(m.startViewTransition).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains('theme-fading')).toBe(false);
  });

  it('applies instantly when the user prefers reduced motion, even with view transitions available', () => {
    const m = stubMotion({ reduced: true, viewTransitions: true });
    const commit = vi.fn();
    runThemeChange(commit, 'reveal', { x: 10, y: 10 });
    runThemeChange(commit, 'fade');
    expect(commit).toHaveBeenCalledTimes(2);
    expect(m.startViewTransition).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains('theme-fading')).toBe(false);
  });

  it('reveals from the origin with one view transition and a circle clip that grows to the far corner', async () => {
    const m = stubMotion({ viewTransitions: true });
    vi.stubGlobal('innerWidth', 300);
    vi.stubGlobal('innerHeight', 400);
    const commit = vi.fn();
    runThemeChange(commit, 'reveal', { x: 0, y: 0 });
    expect(m.startViewTransition).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(m.animate).toHaveBeenCalledTimes(1);
    const [keyframes, options] = m.animate.mock.calls[0]!;
    expect(keyframes).toEqual({ clipPath: ['circle(0px at 0px 0px)', 'circle(500px at 0px 0px)'] });
    expect(options).toMatchObject({ duration: 520, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', pseudoElement: '::view-transition-new(root)' });
  });

  it('still applies the change when the browser skips the view transition', async () => {
    const m = stubMotion({ viewTransitions: true });
    (document as unknown as { startViewTransition: unknown }).startViewTransition = vi.fn((cb: () => void) => {
      cb();
      return { ready: Promise.reject(new DOMException('skipped', 'AbortError')), finished: Promise.resolve() };
    });
    const commit = vi.fn();
    runThemeChange(commit, 'reveal', { x: 1, y: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(m.animate).not.toHaveBeenCalled();
  });

  it('falls back to a 200ms color fade when there is no View Transitions API', () => {
    stubMotion({ viewTransitions: false });
    const commit = vi.fn(() => expect(document.documentElement.classList.contains('theme-fading')).toBe(true));
    runThemeChange(commit, 'reveal', { x: 1, y: 1 });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains('theme-fading')).toBe(true);
    vi.advanceTimersByTime(260);
    expect(document.documentElement.classList.contains('theme-fading')).toBe(false);
  });

  it.each([
    ['an instant change from another tab', { kind: 'none' as const, reduced: false, vt: true }],
    ['a user reveal', { kind: 'reveal' as const, reduced: false, vt: true }],
    ['a reduced-motion change', { kind: 'reveal' as const, reduced: true, vt: true }],
  ])('%s cancels a pending fade: the class goes at once, not when the old timer fires', (_name, o) => {
    stubMotion({ viewTransitions: o.vt });
    runThemeChange(vi.fn(), 'fade');
    expect(document.documentElement.classList.contains('theme-fading')).toBe(true);
    vi.advanceTimersByTime(100);
    stubMotion({ reduced: o.reduced, viewTransitions: o.vt });
    const seen: boolean[] = [];
    runThemeChange(() => seen.push(document.documentElement.classList.contains('theme-fading')), o.kind, { x: 1, y: 1 });
    expect(seen).toEqual([false]);
    expect(document.documentElement.classList.contains('theme-fading')).toBe(false);
    vi.advanceTimersByTime(500);
    expect(document.documentElement.classList.contains('theme-fading')).toBe(false);
  });

  it('uses the same 200ms fade for an OS-driven change, and overlapping fades keep the class until the last ends', () => {
    stubMotion({ viewTransitions: true });
    runThemeChange(vi.fn(), 'fade');
    vi.advanceTimersByTime(150);
    runThemeChange(vi.fn(), 'fade');
    vi.advanceTimersByTime(150);
    expect(document.documentElement.classList.contains('theme-fading')).toBe(true);
    vi.advanceTimersByTime(120);
    expect(document.documentElement.classList.contains('theme-fading')).toBe(false);
  });
});

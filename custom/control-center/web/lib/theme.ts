import { createElement, Fragment, useCallback, useEffect, useSyncExternalStore, type ReactNode } from 'react';

export type ThemeMode = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';
export interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
}

export const THEME_KEY = 'cc.theme';
export const THEME_MODES: readonly ThemeMode[] = ['auto', 'light', 'dark'];
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Keep in step with web/public/theme-boot.js, which makes the same decision before first paint. */
export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  return mode === 'auto' ? (systemDark ? 'dark' : 'light') : mode;
}

const asMode = (value: string | null | undefined): ThemeMode => (value === 'light' || value === 'dark' || value === 'auto' ? value : 'auto');

/** Storage can be blocked (private windows, cleared site data): the choice then lives for this tab only. */
export function readStoredMode(): ThemeMode {
  try {
    return asMode(window.localStorage.getItem(THEME_KEY));
  } catch {
    return 'auto';
  }
}

function writeStoredMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* blocked storage: the in-memory choice still applies */
  }
}

/** matchMedia is absent in some environments; the app's historic default is dark. */
function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY).matches : true;
}

let state: (ThemeState & { systemDark: boolean }) | null = null;
const listeners = new Set<() => void>();

function current() {
  if (!state) {
    const systemDark = systemPrefersDark();
    const mode = readStoredMode();
    state = { mode, systemDark, resolved: resolveTheme(mode, systemDark) };
  }
  return state;
}

/** The snapshot is replaced, never mutated, so useSyncExternalStore sees a stable reference between changes. */
export function getThemeState(): ThemeState {
  return current();
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** With an explicit choice only the matching theme-color meta applies; Auto hands both back to the system. */
function applyMetas(mode: ThemeMode, resolved: ResolvedTheme): void {
  for (const meta of document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"][data-scheme]')) {
    const scheme = meta.dataset.scheme;
    meta.setAttribute('media', mode === 'auto' ? `(prefers-color-scheme: ${scheme})` : scheme === resolved ? 'all' : 'not all');
  }
}

function applyToDocument({ mode, resolved }: ThemeState): void {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themeMode = mode;
  root.style.colorScheme = resolved;
  applyMetas(mode, resolved);
}

function update(next: { mode: ThemeMode; systemDark: boolean }): void {
  const prev = current();
  const resolved = resolveTheme(next.mode, next.systemDark);
  if (prev.mode === next.mode && prev.resolved === resolved && prev.systemDark === next.systemDark) return;
  state = { ...next, resolved };
  applyToDocument(state);
  for (const l of [...listeners]) l();
}

/** Applies the current (stored) choice to <html>; theme-boot.js already did this before paint, so this only heals a missing boot script. */
export function initTheme(): void {
  applyToDocument(current());
}

export function setThemeMode(mode: ThemeMode): void {
  // Read the state before the write: a lazily created state would otherwise pick up the new stored value and see no change.
  const { systemDark } = current();
  writeStoredMode(mode);
  update({ mode, systemDark });
}

/** Live OS changes (they only matter in Auto) and changes made in another tab. Returns the cleanup. */
export function watchSystemAndStorage(): () => void {
  const mql = typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null;
  const onSystem = () => update({ mode: current().mode, systemDark: systemPrefersDark() });
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_KEY || e.key === null) update({ mode: asMode(e.key === null ? null : e.newValue), systemDark: current().systemDark });
  };
  mql?.addEventListener('change', onSystem);
  window.addEventListener('storage', onStorage);
  return () => {
    mql?.removeEventListener('change', onSystem);
    window.removeEventListener('storage', onStorage);
  };
}

/** Mount once near the root: keeps the document in step with OS and cross-tab changes. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    initTheme();
    return watchSystemAndStorage();
  }, []);
  return createElement(Fragment, null, children);
}

/** `origin` is where the change was asked for (a control or a point); the reveal animation grows from there. */
export function useTheme(): ThemeState & { setMode: (mode: ThemeMode, origin?: Element) => void } {
  const snapshot = useSyncExternalStore(subscribeTheme, getThemeState, getThemeState);
  const setMode = useCallback((mode: ThemeMode, _origin?: Element) => setThemeMode(mode), []);
  return { mode: snapshot.mode, resolved: snapshot.resolved, setMode };
}

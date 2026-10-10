import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as ThemeModule from '@web/lib/theme';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOOT_SRC = fs.readFileSync(path.join(ROOT, 'web', 'public', 'theme-boot.js'), 'utf8');

type Theme = typeof ThemeModule;

/** A controllable stand-in for matchMedia('(prefers-color-scheme: dark)'). */
function installSystemTheme(initialDark: boolean | 'unsupported') {
  let dark = initialDark === true;
  const listeners = new Set<() => void>();
  const dm = {
    get matches() {
      return dark;
    },
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_t: string, l: () => void) => listeners.add(l),
    removeEventListener: (_t: string, l: () => void) => listeners.delete(l),
  };
  const mm = (q: string) => (q.includes('prefers-color-scheme: dark') ? dm : { matches: false, media: q, addEventListener() {}, removeEventListener() {} });
  if (initialDark === 'unsupported') {
    vi.stubGlobal('matchMedia', undefined);
    Object.defineProperty(window, 'matchMedia', { value: undefined, configurable: true, writable: true });
  } else {
    vi.stubGlobal('matchMedia', mm);
    Object.defineProperty(window, 'matchMedia', { value: mm, configurable: true, writable: true });
  }
  return {
    set(next: boolean) {
      dark = next;
      for (const l of [...listeners]) l();
    },
    listenerCount: () => listeners.size,
  };
}

function installStorage(initial: Record<string, string> = {}, opts: { throwOnRead?: boolean; throwOnWrite?: boolean } = {}) {
  const data = new Map(Object.entries(initial));
  const storage = {
    getItem: (k: string) => {
      if (opts.throwOnRead) throw new DOMException('blocked', 'SecurityError');
      return data.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.throwOnWrite) throw new DOMException('blocked', 'SecurityError');
      data.set(k, v);
    },
    removeItem: (k: string) => void data.delete(k),
  };
  vi.stubGlobal('localStorage', storage);
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
  return data;
}

async function loadTheme(): Promise<Theme> {
  vi.resetModules();
  return import('@web/lib/theme');
}

const root = () => document.documentElement;

function resetDom() {
  root().removeAttribute('data-theme');
  root().removeAttribute('data-theme-mode');
  root().style.colorScheme = '';
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
}

beforeEach(resetDom);
afterEach(() => {
  vi.unstubAllGlobals();
  resetDom();
});

describe('resolveTheme', () => {
  it.each([
    ['auto', true, 'dark'],
    ['auto', false, 'light'],
    ['light', true, 'light'],
    ['dark', false, 'dark'],
  ] as const)('mode %s with system dark=%s is %s', async (mode, systemDark, expected) => {
    installSystemTheme(false);
    installStorage();
    const { resolveTheme } = await loadTheme();
    expect(resolveTheme(mode, systemDark)).toBe(expected);
  });
});

describe('readStoredMode', () => {
  it.each([
    ['light', 'light'],
    ['dark', 'dark'],
    ['auto', 'auto'],
    ['sepia', 'auto'],
    ['', 'auto'],
  ])('a stored "%s" reads as %s', async (stored, expected) => {
    installSystemTheme(false);
    installStorage({ 'cc.theme': stored });
    const { readStoredMode } = await loadTheme();
    expect(readStoredMode()).toBe(expected);
  });

  it('is auto when nothing is stored', async () => {
    installSystemTheme(false);
    installStorage();
    const { readStoredMode } = await loadTheme();
    expect(readStoredMode()).toBe('auto');
  });

  it('is auto when storage throws (blocked site data)', async () => {
    installSystemTheme(false);
    installStorage({}, { throwOnRead: true });
    const { readStoredMode } = await loadTheme();
    expect(readStoredMode()).toBe('auto');
  });
});

describe('theme store', () => {
  it('starts from the stored mode and applies it to <html>', async () => {
    installSystemTheme(true);
    installStorage({ 'cc.theme': 'light' });
    const t = await loadTheme();
    t.initTheme();
    expect(t.getThemeState()).toMatchObject({ mode: 'light', resolved: 'light' });
    expect(root().dataset.theme).toBe('light');
    expect(root().dataset.themeMode).toBe('light');
    expect(root().style.colorScheme).toBe('light');
  });

  it('auto follows the system, live', async () => {
    const sys = installSystemTheme(false);
    installStorage();
    const t = await loadTheme();
    const stop = t.watchSystemAndStorage();
    expect(t.getThemeState()).toMatchObject({ mode: 'auto', resolved: 'light' });
    sys.set(true);
    expect(t.getThemeState().resolved).toBe('dark');
    expect(root().dataset.theme).toBe('dark');
    expect(root().dataset.themeMode).toBe('auto');
    expect(root().style.colorScheme).toBe('dark');
    sys.set(false);
    expect(root().dataset.theme).toBe('light');
    stop();
  });

  it('an explicit mode ignores the system until Auto is chosen again', async () => {
    const sys = installSystemTheme(false);
    const data = installStorage();
    const t = await loadTheme();
    const stop = t.watchSystemAndStorage();
    t.setThemeMode('light');
    expect(data.get('cc.theme')).toBe('light');
    // The OS ends on the scheme it did not start on, so Auto shows whether the flip was recorded while it was ignored.
    sys.set(true);
    expect(root().dataset.theme).toBe('light');
    t.setThemeMode('auto');
    expect(data.get('cc.theme')).toBe('auto');
    expect(root().dataset.theme).toBe('dark');
    sys.set(false);
    expect(root().dataset.theme).toBe('light');
    stop();
  });

  it('still switches for this tab when storage refuses the write', async () => {
    installSystemTheme(false);
    installStorage({}, { throwOnWrite: true });
    const t = await loadTheme();
    expect(() => t.setThemeMode('dark')).not.toThrow();
    expect(t.getThemeState()).toMatchObject({ mode: 'dark', resolved: 'dark' });
    expect(root().dataset.theme).toBe('dark');
  });

  it('follows a change made in another tab (storage event), and ignores other keys', async () => {
    installSystemTheme(false);
    installStorage();
    const t = await loadTheme();
    const stop = t.watchSystemAndStorage();
    window.dispatchEvent(new StorageEvent('storage', { key: 'cc.theme', newValue: 'dark' }));
    expect(t.getThemeState()).toMatchObject({ mode: 'dark', resolved: 'dark' });
    expect(root().dataset.theme).toBe('dark');
    window.dispatchEvent(new StorageEvent('storage', { key: 'something.else', newValue: 'light' }));
    expect(t.getThemeState().mode).toBe('dark');
    window.dispatchEvent(new StorageEvent('storage', { key: 'cc.theme', newValue: null }));
    expect(t.getThemeState()).toMatchObject({ mode: 'auto', resolved: 'light' });
    stop();
  });

  it('catches up with an OS change that happened before the watcher was registered', async () => {
    const sys = installSystemTheme(false);
    installStorage();
    const t = await loadTheme();
    t.initTheme();
    expect(t.getThemeState().resolved).toBe('light');
    sys.set(true); // no listener yet: the change is missed unless the watcher samples on start
    const stop = t.watchSystemAndStorage();
    expect(t.getThemeState()).toMatchObject({ mode: 'auto', resolved: 'dark' });
    expect(root().dataset.theme).toBe('dark');
    stop();
  });

  it('does not let a catch-up sample override an explicit choice', async () => {
    const sys = installSystemTheme(false);
    installStorage({ 'cc.theme': 'light' });
    const t = await loadTheme();
    t.initTheme();
    sys.set(true);
    const stop = t.watchSystemAndStorage();
    expect(t.getThemeState()).toMatchObject({ mode: 'light', resolved: 'light' });
    stop();
  });

  it('treats a missing matchMedia as a dark system (the app default) instead of throwing', async () => {
    installSystemTheme('unsupported');
    installStorage();
    const t = await loadTheme();
    const stop = t.watchSystemAndStorage();
    expect(t.getThemeState()).toMatchObject({ mode: 'auto', resolved: 'dark' });
    stop();
  });

  it('removes its listeners when the watcher is stopped', async () => {
    const sys = installSystemTheme(false);
    installStorage();
    const t = await loadTheme();
    const stop = t.watchSystemAndStorage();
    expect(sys.listenerCount()).toBe(1);
    stop();
    expect(sys.listenerCount()).toBe(0);
  });

  it('notifies subscribers once per real change and not for a no-op', async () => {
    installSystemTheme(false);
    installStorage();
    const t = await loadTheme();
    const seen: string[] = [];
    const off = t.subscribeTheme(() => seen.push(t.getThemeState().mode));
    t.setThemeMode('light');
    t.setThemeMode('light');
    t.setThemeMode('dark');
    off();
    t.setThemeMode('auto');
    expect(seen).toEqual(['light', 'dark']);
  });

  it('switches which theme-color meta applies when overriding, and restores both for Auto', async () => {
    installSystemTheme(true);
    installStorage();
    const t = await loadTheme();
    for (const scheme of ['light', 'dark']) {
      const m = document.createElement('meta');
      m.name = 'theme-color';
      m.dataset.scheme = scheme;
      m.media = `(prefers-color-scheme: ${scheme})`;
      document.head.append(m);
    }
    const light = () => document.querySelector<HTMLMetaElement>('meta[data-scheme="light"]')!;
    const dark = () => document.querySelector<HTMLMetaElement>('meta[data-scheme="dark"]')!;
    t.setThemeMode('light');
    expect([light().getAttribute('media'), dark().getAttribute('media')]).toEqual(['all', 'not all']);
    t.setThemeMode('dark');
    expect([light().getAttribute('media'), dark().getAttribute('media')]).toEqual(['not all', 'all']);
    t.setThemeMode('auto');
    expect([light().getAttribute('media'), dark().getAttribute('media')]).toEqual(['(prefers-color-scheme: light)', '(prefers-color-scheme: dark)']);
  });
});

describe('how a change is animated', () => {
  it('an explicit choice reveals from the control, an OS change fades, a change from another tab is instant', async () => {
    const sys = installSystemTheme(false);
    installStorage();
    const kinds: string[] = [];
    vi.doMock('@web/lib/theme-transition', () => ({
      runThemeChange: (commit: () => void, kind: string, origin?: unknown) => {
        kinds.push(origin ? `${kind}:origin` : kind);
        commit();
      },
    }));
    const t = await loadTheme();
    const stop = t.watchSystemAndStorage();
    const trigger = document.createElement('button');
    t.setThemeMode('dark', trigger); // light -> dark: revealed from the control
    sys.set(true); // an explicit mode ignores the system: nothing to animate
    t.setThemeMode('auto'); // dark -> dark: only the mode label changes
    sys.set(false); // auto, dark -> light: an OS-driven fade
    window.dispatchEvent(new StorageEvent('storage', { key: 'cc.theme', newValue: 'dark' })); // another tab: instant
    t.setThemeMode('light'); // dark -> light without an origin: still a reveal
    stop();
    vi.doUnmock('@web/lib/theme-transition');
    expect(kinds).toEqual(['reveal:origin', 'fade', 'none', 'reveal']);
  });
});

describe('theme-boot.js (the pre-paint script) agrees with resolveTheme', () => {
  const TABLE: Array<[stored: string | null | 'throws', systemDark: boolean | 'unsupported']> = [
    [null, true],
    [null, false],
    ['auto', true],
    ['auto', false],
    ['light', true],
    ['light', false],
    ['dark', true],
    ['dark', false],
    ['bogus', false],
    ['throws', true],
    [null, 'unsupported'],
  ];

  it.each(TABLE)('stored %s with system dark=%s', async (stored, systemDark) => {
    installSystemTheme(systemDark);
    installStorage(typeof stored === 'string' && stored !== 'throws' ? { 'cc.theme': stored } : {}, { throwOnRead: stored === 'throws' });
    new Function(BOOT_SRC)();
    const booted = { theme: root().dataset.theme, mode: root().dataset.themeMode, scheme: root().style.colorScheme };
    resetDom();
    const t = await loadTheme();
    t.initTheme();
    const state = t.getThemeState();
    expect(booted).toEqual({ theme: state.resolved, mode: state.mode, scheme: state.resolved });
  });

  it('creates the two theme-color metas with the chrome color of each theme, in the order the browser needs', async () => {
    installSystemTheme(false);
    installStorage({ 'cc.theme': 'dark' });
    new Function(BOOT_SRC)();
    const metas = [...document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
    expect(metas.map((m) => m.dataset.scheme)).toEqual(['light', 'dark']);
    const tokens = fs.readFileSync(path.join(ROOT, 'web', 'styles', 'tokens.css'), 'utf8');
    const chrome = (block: RegExp) => block.exec(tokens)![1]!.toLowerCase();
    expect(metas[0]!.content.toLowerCase()).toBe(chrome(/\[data-theme='light'\] \{[\s\S]*?--chrome: (#[0-9a-f]{6});/));
    expect(metas[1]!.content.toLowerCase()).toBe(chrome(/\[data-theme='dark'\] \{[\s\S]*?--chrome: (#[0-9a-f]{6});/));
    expect([metas[0]!.getAttribute('media'), metas[1]!.getAttribute('media')]).toEqual(['not all', 'all']);
  });
});

describe('index.html', () => {
  const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

  it('loads the boot script first, render-blocking, before any module or stylesheet', () => {
    const boot = html.search(/<script\s+src="\/theme-boot\.js"\s*><\/script>/);
    expect(boot).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(html.indexOf('type="module"'));
    expect(html).not.toMatch(/theme-boot\.js"[^>]*(async|defer|type=)/);
    const stylesheet = html.indexOf('rel="stylesheet"');
    if (stylesheet > -1) expect(boot).toBeLessThan(stylesheet);
  });

  it('declares support for both color schemes', () => {
    expect(html).toContain('<meta name="color-scheme" content="light dark" />');
    expect(html).not.toContain('content="dark"');
  });
});

// The last session a page started in this browser tab, so coming back to the page re-attaches it instead of losing it.
// Kept in sessionStorage: a storage that throws (a private window) only loses that re-attaching.
const SESSION_ID = /^[\w-]{1,80}$/;

// A start still marked but not reported within this window was lost (its page reloaded and the POST never came back);
// the mark is cleared so the start form is not disabled forever.
export const START_REPORT_WINDOW_MS = 15_000;

export interface LastSession {
  read(): string | null;
  write(id: string | null): void;
  /** Called when the session is deleted, so it is not re-attached. */
  forget(id: string): void;
  /** A start this browser tab sent that has not reported its session or its failure yet. */
  starting(): boolean;
  setStarting(on: boolean): void;
}

export function lastSession(key: string): LastSession {
  const read = (): string | null => {
    try {
      const id = sessionStorage.getItem(key);
      return id && SESSION_ID.test(id) ? id : null;
    } catch {
      return null;
    }
  };
  const write = (id: string | null): void => {
    try {
      if (id) sessionStorage.setItem(key, id);
      else sessionStorage.removeItem(key);
    } catch {
      // storage refused: only the re-attaching is lost
    }
  };
  const startKey = `${key}:starting`;
  // The mark self-expires: a start that never reports (its page reloaded and the POST was lost) must not leave the
  // start form disabled forever. `starting()` is true only while the mark is set AND still within the window.
  const starting = (): boolean => {
    try {
      const raw = sessionStorage.getItem(startKey);
      if (raw === null) return false;
      const at = Number(raw);
      return Number.isFinite(at) && Date.now() - at <= START_REPORT_WINDOW_MS;
    } catch {
      return false;
    }
  };
  const setStarting = (on: boolean): void => {
    try {
      if (on) sessionStorage.setItem(startKey, String(Date.now()));
      else sessionStorage.removeItem(startKey);
    } catch {
      // storage refused: a page mounted mid-start only misses that the start is under way
    }
  };
  return { read, write, forget: (id) => void (read() === id && write(null)), starting, setStarting };
}

const MODE_ID = /^[\w/-]{1,100}$/;

export interface Launch {
  mode: string;
  id: string;
}

// A launcher's panel may report its started session after the launcher unmounted (the page was left before
// POST /api/sessions answered). The report is added to the store directly, and a launcher mounted under the key hears it.
const launchListeners = new Map<string, Set<() => void>>();

/**
 * Every session a mode launcher started in this browser tab, newest first, so coming back shows each one again. `add`
 * records one start and tells every launcher mounted under the key (`subscribe`).
 */
export function rememberedLaunches(key: string): { read(): Launch[]; write(launches: Launch[]): void; add(launch: Launch): void; subscribe(fn: () => void): () => void } {
  const read = (): Launch[] => {
    try {
      const parsed: unknown = JSON.parse(sessionStorage.getItem(key) ?? '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((l): l is Launch => typeof l?.mode === 'string' && MODE_ID.test(l.mode) && typeof l?.id === 'string' && SESSION_ID.test(l.id));
    } catch {
      return [];
    }
  };
  const write = (launches: Launch[]): void => {
    try {
      if (launches.length) sessionStorage.setItem(key, JSON.stringify(launches));
      else sessionStorage.removeItem(key);
    } catch {
      // storage refused: only the re-attaching is lost
    }
  };
  const add = (launch: Launch): void => {
    write([launch, ...read().filter((l) => l.id !== launch.id)]);
    for (const fn of launchListeners.get(key) ?? []) fn();
  };
  const subscribe = (fn: () => void) => {
    const set = launchListeners.get(key) ?? new Set();
    set.add(fn);
    launchListeners.set(key, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) launchListeners.delete(key);
    };
  };
  return { read, write, add, subscribe };
}

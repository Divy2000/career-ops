// The last session a page started in this browser tab, so coming back to the page re-attaches it instead of losing it.
// Kept in sessionStorage: a storage that throws (a private window) only loses that re-attaching.
const SESSION_ID = /^[\w-]{1,80}$/;
// Marks a start as this page load's: a reload drops the request, so a mark left by an earlier load means nothing.
const LOAD = Math.random().toString(36).slice(2);

export interface LastSession {
  read(): string | null;
  write(id: string | null): void;
  /** Called when the session is deleted, so it is not re-attached. */
  forget(id: string): void;
  /** A start this page load sent that has not reported its session or its failure yet. */
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
  const starting = (): boolean => {
    try {
      return sessionStorage.getItem(startKey) === LOAD;
    } catch {
      return false;
    }
  };
  const setStarting = (on: boolean): void => {
    try {
      if (on) sessionStorage.setItem(startKey, LOAD);
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

/** Every session a mode launcher started in this browser tab, newest first, so coming back shows each one again. */
export function rememberedLaunches(key: string): { read(): Launch[]; write(launches: Launch[]): void } {
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
  return { read, write };
}

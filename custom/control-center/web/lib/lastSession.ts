// The last session a page started in this browser tab, so coming back to the page re-attaches it instead of losing it.
// Kept in sessionStorage: a storage that throws (a private window) only loses that re-attaching.
const SESSION_ID = /^[\w-]{1,80}$/;

export interface LastSession {
  read(): string | null;
  write(id: string | null): void;
  /** Called when the session is deleted, so it is not re-attached. */
  forget(id: string): void;
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
  return { read, write, forget: (id) => void (read() === id && write(null)) };
}

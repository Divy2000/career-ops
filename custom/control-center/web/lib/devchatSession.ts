// The last Dev Chat session of this browser tab, so /dev with no ?session= (the sidebar link, the reload banner)
// reopens it. Kept in sessionStorage: a storage that throws (a private window) only loses that reopening.
const LAST_SESSION = 'cc.devchat.session';
const SESSION_ID = /^[\w-]{1,80}$/;

export function readLastDevSession(): string | null {
  try {
    const id = sessionStorage.getItem(LAST_SESSION);
    return id && SESSION_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function writeLastDevSession(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(LAST_SESSION, id);
    else sessionStorage.removeItem(LAST_SESSION);
  } catch {
    // storage refused: only the reopening of a plain /dev is lost
  }
}

/** A deleted session is not reopened: called when the Sessions page deletes one. */
export function forgetDevSession(id: string): void {
  if (readLastDevSession() === id) writeLastDevSession(null);
}

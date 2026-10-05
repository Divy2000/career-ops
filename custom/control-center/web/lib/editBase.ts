import { useState } from 'react';

export interface EditBase<T> {
  /** The server version the current edit started from; null while nothing is being edited. */
  base: T | null;
  /** Pins the version on screen as the base, unless the edit already has one. Call it on every change. */
  pin: () => void;
  /** Moves the base (to the version a 409 returned, once it is shown) or clears it (null) when the edit ends. */
  rebase: (next: T | null) => void;
  /** The live version is no longer the one the edit started from: another writer changed the file. */
  drifted: boolean;
}

/**
 * An editor saves with the ETag of the version its draft was made on, never the newest one: the watcher refetches
 * every config file as soon as it changes on disk, and sending that ETag would overwrite the other change silently.
 */
export function useEditBase<T extends { etag: string | null }>(live: T | undefined): EditBase<T> {
  const [base, setBase] = useState<T | null>(null);
  return {
    base,
    pin: () => setBase((b) => b ?? live ?? null),
    rebase: setBase,
    drifted: base !== null && live !== undefined && live.etag !== base.etag,
  };
}

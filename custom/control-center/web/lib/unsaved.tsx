// Unsaved edits on a page, so a tab switch that would unmount an editor (and with it the edits) asks first. Editors
// report what they would lose with useUnsaved; a tab's onChange goes through useLeaveGuard.
import { createContext, useCallback, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { useConfirm } from '../components/ConfirmDialog';

const UnsavedContext = createContext<Map<string, string> | null>(null);

export function UnsavedProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new Map<string, string>());
  return <UnsavedContext.Provider value={registry}>{children}</UnsavedContext.Provider>;
}

/** Marks `what` (a file or a form, as the user knows it) as holding unsaved edits while `dirty`, until unmount. */
export function useUnsaved(what: string, dirty: boolean): void {
  const registry = useContext(UnsavedContext);
  const id = useId();
  useEffect(() => {
    if (!registry || !dirty) return;
    registry.set(id, what);
    return () => {
      registry.delete(id);
    };
  }, [registry, id, what, dirty]);
}

/** Resolves true when it is fine to leave: nothing unsaved, or the user chose to discard it. */
export function useLeaveGuard(): () => Promise<boolean> {
  const registry = useContext(UnsavedContext);
  const confirm = useConfirm();
  return useCallback(async () => {
    const what = [...new Set(registry?.values() ?? [])];
    if (what.length === 0) return true;
    return await confirm({
      title: 'Discard unsaved changes?',
      body: `${what.join(', ')} ${what.length === 1 ? 'has' : 'have'} unsaved changes, which switching discards. Save them first, or discard them.`,
      confirmLabel: 'Discard changes',
      danger: true,
    });
  }, [registry, confirm]);
}

/** A tab setter that asks before discarding unsaved edits. */
export function useGuardedTab<T>(set: (t: T) => void): (t: T) => void {
  const leave = useLeaveGuard();
  return (t: T) => {
    void leave().then((ok) => ok && set(t));
  };
}

// Unsaved edits on a page, so leaving it or one of its tabs (which unmounts an editor, and with it the edits) asks
// first. Editors report what they would lose with useUnsaved. A tab's onChange goes through useGuardedTab; browser
// Back and Forward, links and closing or reloading the tab are caught by the provider's router blocker and unload guard.
import { createContext, useCallback, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { useBlocker, useRouter } from '@tanstack/react-router';
import { useConfirm } from '../components/ConfirmDialog';

interface Registry {
  entries: Map<string, string>;
  /** Marks the one navigation a guarded tab makes after its own question, so the blocker does not ask again. */
  approveNext: () => void;
  /** True, once, for a navigation approveNext marked. */
  takeApproval: () => boolean;
}

function createRegistry(): Registry {
  let approved = false;
  return {
    entries: new Map(),
    approveNext: () => {
      approved = true;
      setTimeout(() => {
        approved = false;
      }, 0);
    },
    takeApproval: () => {
      const was = approved;
      approved = false;
      return was;
    },
  };
}

const UnsavedContext = createContext<Registry | null>(null);

function useAsk(registry: Registry | null) {
  const confirm = useConfirm();
  return useCallback(async () => {
    const what = [...new Set(registry?.entries.values() ?? [])];
    if (what.length === 0) return true;
    return await confirm({
      title: 'Discard unsaved changes?',
      body: `${what.join(', ')} ${what.length === 1 ? 'has' : 'have'} unsaved changes, which leaving discards. Save them first, or discard them.`,
      confirmLabel: 'Discard changes',
      danger: true,
    });
  }, [registry, confirm]);
}

export function UnsavedProvider({ children }: { children: ReactNode }) {
  const [registry] = useState<Registry>(createRegistry);
  // Outside a router (a component test) there is no navigation to guard, only tabs.
  const router = useRouter({ warn: false });
  return (
    <UnsavedContext.Provider value={registry}>
      {router && <NavigationGuard registry={registry} />}
      {children}
    </UnsavedContext.Provider>
  );
}

function NavigationGuard({ registry }: { registry: Registry }) {
  const ask = useAsk(registry);
  useBlocker({
    shouldBlockFn: async () => {
      if (registry.takeApproval()) return false;
      return !(await ask());
    },
    enableBeforeUnload: () => registry.entries.size > 0,
  });
  return null;
}

/** Marks `what` (a file or a form, as the user knows it) as holding unsaved edits while `dirty`, until unmount. */
export function useUnsaved(what: string, dirty: boolean): void {
  const registry = useContext(UnsavedContext);
  const id = useId();
  useEffect(() => {
    if (!registry || !dirty) return;
    registry.entries.set(id, what);
    return () => {
      registry.entries.delete(id);
    };
  }, [registry, id, what, dirty]);
}

/** A tab setter that asks before discarding unsaved edits; a tab kept in the URL then navigates without a second ask. */
export function useGuardedTab<T>(set: (t: T) => void): (t: T) => void {
  const registry = useContext(UnsavedContext);
  const ask = useAsk(registry);
  return (t: T) => {
    void ask().then((ok) => {
      if (!ok) return;
      if (registry && registry.entries.size > 0) registry.approveNext();
      set(t);
    });
  };
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pill } from './ui';
import { useConfirm } from './ConfirmDialog';
import { watchActionPosts } from '../lib/actions';
import type { ActionMeta } from '@shared/api';

export function CostPill({ cost }: { cost: ActionMeta['cost'] }) {
  const label = cost === 'free' ? 'Free' : cost === 'network' ? 'Network' : 'Uses tokens';
  return <Pill tone={cost === 'tokens' ? 'warn' : cost === 'network' ? 'info' : 'neutral'}>{label}</Pill>;
}

// A run's promise can outlast its POST (useRunAction waits on a runs refetch that has no limit of its own). The lock
// lasts until the POST is answered, however long that takes, then at most REFETCH_GRACE_MS more for the rest of the run.
// A run whose POST this cannot see (onRun sends it after an await) is locked until the server's 30 s sync timeout has
// surely answered it, so a stalled refetch cannot lock the button for good either way.
const RUN_LOCK_LIMIT_MS = 35_000;
const REFETCH_GRACE_MS = 5_000;
async function withinRunLockLimit(start: () => void | Promise<unknown>): Promise<void> {
  const { value: run, posts } = watchActionPosts(start);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = (ms: number) => new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)));
  try {
    if (posts.length === 0) {
      await Promise.race([run, limit(RUN_LOCK_LIMIT_MS)]);
      return;
    }
    // An onRun that returns nothing leaves only its POSTs to wait on: racing its undefined would unlock at once.
    if (!(run instanceof Promise)) {
      await Promise.all(posts);
      return;
    }
    await Promise.race([run, Promise.all(posts)]);
    await Promise.race([run, limit(REFETCH_GRACE_MS)]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Button for a registry action: shows the cost badge and asks (Radix dialog) when the action declares a confirm text.
 * onRun gets `confirmed: true` once the user confirmed, which the request must carry (the server refuses otherwise).
 * An onRun that returns its run's promise keeps the button from starting the run again until it settles (see withinRunLockLimit).
 */
export function ActionButton({ meta, onRun, disabled, children, params }: { meta: ActionMeta | undefined; onRun: (params: Record<string, unknown>, opts: { confirmed: boolean }) => void | Promise<unknown>; disabled?: boolean; children?: ReactNode; params?: Record<string, unknown> }) {
  const confirm = useConfirm();
  // Confirms queue, so a second click while one is asking would ask twice, and one while the run is in flight would run
  // it twice: both are ignored.
  const asking = useRef(false);
  // Shown while the run is in flight, so a click it ignores does not look like a dead button. Not while the confirm
  // is open: the dialog hands focus back to this button when it closes.
  const [running, setRunning] = useState(false);
  // A browser drops focus to the page from a focused button that becomes disabled: once the run ends and the button is
  // enabled again, focus goes back to it if it had focus at the click, unless the user has put it somewhere else meanwhile.
  // A caller can keep it off past the run (the run it started is still going), so this waits for the button to be on,
  // but any click or focus elsewhere on the page from the run's start on means the user has moved on, even if focus
  // ends on the page again.
  const button = useRef<HTMLButtonElement>(null);
  const ran = useRef(false);
  const mounted = useRef(true);
  const stopWatching = useRef<(() => void) | null>(null);
  const forget = () => {
    ran.current = false;
    stopWatching.current?.();
    stopWatching.current = null;
  };
  const remember = () => {
    forget();
    if (!mounted.current) return;
    ran.current = true;
    const movedOn = (event: Event) => {
      if (!(event.target instanceof Node && button.current?.contains(event.target))) forget();
    };
    document.addEventListener('pointerdown', movedOn, true);
    document.addEventListener('focusin', movedOn, true);
    stopWatching.current = () => {
      document.removeEventListener('pointerdown', movedOn, true);
      document.removeEventListener('focusin', movedOn, true);
    };
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      forget();
    };
  }, []);
  const off = Boolean(disabled) || running;
  useEffect(() => {
    if (off || !ran.current) return;
    forget();
    const active = document.activeElement;
    if (active === null || active === document.body) button.current?.focus({ preventScroll: true });
  }, [off]);
  if (!meta) return null;
  return (
    <button
      ref={button}
      type="button"
      disabled={off}
      title={meta.confirm ?? undefined}
      onClick={() => {
        if (asking.current) return;
        asking.current = true;
        // Safari and Firefox on macOS do not focus a button clicked with the mouse: only a button that had focus gets it back.
        const hadFocus = document.activeElement === button.current;
        void (async () => {
          let started = false;
          try {
            if (meta.confirm && !(await confirm({ title: meta.label, body: meta.confirm, confirmLabel: 'Run', danger: true }))) return;
            started = true;
            if (hadFocus) remember();
            setRunning(true);
            await withinRunLockLimit(() => onRun(params ?? {}, { confirmed: Boolean(meta.confirm) }));
          } catch (err) {
            console.error(`${meta.id} failed:`, err);
          } finally {
            asking.current = false;
            if (!started || !hadFocus) forget();
            setRunning(false);
          }
        })();
      }}
    >
      {children ?? meta.label} <CostPill cost={meta.cost} />
    </button>
  );
}

export function Message({ message }: { message: { tone: 'ok' | 'danger'; text: string } | null }) {
  if (!message) return null;
  return (
    <p role={message.tone === 'danger' ? 'alert' : 'status'} className={message.tone === 'danger' ? 'danger-text' : 'muted'}>
      {message.text}
    </p>
  );
}

/** A sync action's output (stdout and stderr) under the buttons that ran it. */
export function ActionOutput({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <pre tabIndex={0} aria-label="Action output" className="log mono small">
      {text}
    </pre>
  );
}

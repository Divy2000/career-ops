import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pill } from './ui';
import { useConfirm } from './ConfirmDialog';
import type { ActionMeta } from '@shared/api';

export function CostPill({ cost }: { cost: ActionMeta['cost'] }) {
  const label = cost === 'free' ? 'Free' : cost === 'network' ? 'Network' : 'Uses tokens';
  return <Pill tone={cost === 'tokens' ? 'warn' : cost === 'network' ? 'info' : 'neutral'}>{label}</Pill>;
}

// A run's promise can outlast its POST (useRunAction waits on a runs refetch that has no limit of its own). The lock
// ends once the server's 30 s sync timeout has surely answered the POST, so a stalled refetch cannot lock the button for good.
const RUN_LOCK_LIMIT_MS = 35_000;
async function withinRunLockLimit(run: void | Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([run, new Promise<void>((resolve) => (timer = setTimeout(resolve, RUN_LOCK_LIMIT_MS)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Button for a registry action: shows the cost badge and asks (Radix dialog) when the action declares a confirm text.
 * onRun gets `confirmed: true` once the user confirmed, which the request must carry (the server refuses otherwise).
 * An onRun that returns its run's promise keeps the button from starting the run again until it settles (at most RUN_LOCK_LIMIT_MS).
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
            await withinRunLockLimit(onRun(params ?? {}, { confirmed: Boolean(meta.confirm) }));
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

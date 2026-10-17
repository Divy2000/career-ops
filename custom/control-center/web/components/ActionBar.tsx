import { useRef, useState, type ReactNode } from 'react';
import { Pill } from './ui';
import { useConfirm } from './ConfirmDialog';
import type { ActionMeta } from '@shared/api';

export function CostPill({ cost }: { cost: ActionMeta['cost'] }) {
  const label = cost === 'free' ? 'Free' : cost === 'network' ? 'Network' : 'Uses tokens';
  return <Pill tone={cost === 'tokens' ? 'warn' : cost === 'network' ? 'info' : 'neutral'}>{label}</Pill>;
}

/**
 * Button for a registry action: shows the cost badge and asks (Radix dialog) when the action declares a confirm text.
 * onRun gets `confirmed: true` once the user confirmed, which the request must carry (the server refuses otherwise).
 * An onRun that returns its run's promise keeps the button from starting the run again until it settles.
 */
export function ActionButton({ meta, onRun, disabled, children, params }: { meta: ActionMeta | undefined; onRun: (params: Record<string, unknown>, opts: { confirmed: boolean }) => void | Promise<unknown>; disabled?: boolean; children?: ReactNode; params?: Record<string, unknown> }) {
  const confirm = useConfirm();
  // Confirms queue, so a second click while one is asking would ask twice, and one while the run is in flight would run
  // it twice: both are ignored.
  const asking = useRef(false);
  // Shown while the run is in flight, so a click it ignores does not look like a dead button. Not while the confirm
  // is open: the dialog hands focus back to this button when it closes.
  const [running, setRunning] = useState(false);
  if (!meta) return null;
  return (
    <button
      type="button"
      disabled={disabled || running}
      title={meta.confirm ?? undefined}
      onClick={() => {
        if (asking.current) return;
        asking.current = true;
        void (async () => {
          try {
            if (meta.confirm && !(await confirm({ title: meta.label, body: meta.confirm, confirmLabel: 'Run', danger: true }))) return;
            setRunning(true);
            await onRun(params ?? {}, { confirmed: Boolean(meta.confirm) });
          } catch (err) {
            console.error(`${meta.id} failed:`, err);
          } finally {
            asking.current = false;
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

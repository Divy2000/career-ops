import * as Dialog from '@radix-ui/react-dialog';
import { createContext, useCallback, useContext, useRef, useState, type MouseEvent, type ReactNode } from 'react';

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive confirms get the danger button style. */
  danger?: boolean;
  /** Opens on Cancel without the danger style: for confirms that spend tokens. A destructive confirm always does. */
  focusCancel?: boolean;
}

type Ask = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Ask | null>(null);

/** Promise-based Radix Dialog confirm: the only confirmation primitive in web/ (no window.confirm). */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  // Asks wait in turn (first in, first shown): a confirm asked while one is open must not swap the text the user is
  // reading, nor drop the open one's caller unanswered.
  const [queue, setQueue] = useState<{ id: number; opts: ConfirmOptions; resolve: (v: boolean) => void }[]>([]);
  const nextId = useRef(0);
  const ask = useCallback<Ask>((opts) => new Promise<boolean>((resolve) => setQueue((q) => [...q, { id: ++nextId.current, opts, resolve }])), []);
  const pending = queue[0] ?? null;
  const settle = (value: boolean) => {
    if (!pending) return;
    pending.resolve(value);
    setQueue((q) => q.filter((p) => p !== pending));
  };
  // A repeat click of a double click (detail 2+) answers nothing: the first click settled the confirm it was aimed at,
  // and the next queued one, shown in its place with its buttons where they were, has not been read yet.
  const click = (value: boolean) => (e: MouseEvent<HTMLButtonElement>) => {
    if (e.detail > 1) return;
    settle(value);
  };
  const opts = pending?.opts;
  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      <Dialog.Root open={pending !== null} onOpenChange={(open) => !open && settle(false)}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog__overlay" />
          <Dialog.Content key={pending?.id} className="dialog" aria-describedby={opts?.body ? 'confirm-body' : undefined}>
            <Dialog.Title className="dialog__title">{opts?.title}</Dialog.Title>
            {opts?.body && (
              <Dialog.Description asChild>
                <div id="confirm-body" className="dialog__body muted">
                  {opts.body}
                </div>
              </Dialog.Description>
            )}
            <div className="row gap dialog__actions">
              {/* A destructive or paid confirm starts on Cancel, so the Enter that opened it (held, or pressed twice) cannot confirm it. */}
              <button type="button" onClick={click(false)} autoFocus={Boolean(opts?.danger || opts?.focusCancel)}>
                {opts?.cancelLabel ?? 'Cancel'}
              </button>
              <button type="button" className={opts?.danger ? 'button--danger' : 'button--primary'} onClick={click(true)} autoFocus={!(opts?.danger || opts?.focusCancel)}>
                {opts?.confirmLabel ?? 'Confirm'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): Ask {
  const ask = useContext(ConfirmContext);
  if (!ask) throw new Error('useConfirm must be used inside ConfirmProvider');
  return ask;
}

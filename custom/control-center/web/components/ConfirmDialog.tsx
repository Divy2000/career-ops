import * as Dialog from '@radix-ui/react-dialog';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

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
  const [pending, setPending] = useState<{ opts: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);
  const ask = useCallback<Ask>((opts) => new Promise<boolean>((resolve) => setPending({ opts, resolve })), []);
  const settle = (value: boolean) => {
    pending?.resolve(value);
    setPending(null);
  };
  const opts = pending?.opts;
  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      <Dialog.Root open={pending !== null} onOpenChange={(open) => !open && settle(false)}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog__overlay" />
          <Dialog.Content className="dialog" aria-describedby={opts?.body ? 'confirm-body' : undefined}>
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
              <button type="button" onClick={() => settle(false)} autoFocus={Boolean(opts?.danger || opts?.focusCancel)}>
                {opts?.cancelLabel ?? 'Cancel'}
              </button>
              <button type="button" className={opts?.danger ? 'button--danger' : 'button--primary'} onClick={() => settle(true)} autoFocus={!(opts?.danger || opts?.focusCancel)}>
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

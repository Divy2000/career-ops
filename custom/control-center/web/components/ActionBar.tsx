import type { ReactNode } from 'react';
import { Pill } from './ui';
import type { ActionMeta } from '@shared/api';

export function CostPill({ cost }: { cost: ActionMeta['cost'] }) {
  const label = cost === 'free' ? 'Free' : cost === 'network' ? 'Network' : 'Uses tokens';
  return <Pill tone={cost === 'tokens' ? 'warn' : cost === 'network' ? 'info' : 'neutral'}>{label}</Pill>;
}

/** Button for a registry action: shows the cost badge and asks for confirmation when the action declares one. */
export function ActionButton({ meta, onRun, disabled, children, params }: { meta: ActionMeta | undefined; onRun: (params: Record<string, unknown>) => void; disabled?: boolean; children?: ReactNode; params?: Record<string, unknown> }) {
  if (!meta) return null;
  return (
    <button
      type="button"
      disabled={disabled}
      title={meta.confirm ?? undefined}
      onClick={() => {
        if (meta.confirm && !window.confirm(meta.confirm)) return;
        onRun(params ?? {});
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

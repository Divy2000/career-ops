import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiSend } from '../../lib/api';
import { describeError } from '../../lib/actions';
import type { TrackerRow } from '@shared/api';
import { HiredDialog } from './HiredDialog';

export const STATES = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP'] as const;
export const DISCARD_REASONS = ['comp below floor', 'no visa sponsorship', 'location mismatch', 'level mismatch', 'staffing agency', 'posting closed', 'culture concerns'];

/** Sets a tracker row's status through tracker.setStatus; the message says what happened, or why it did not. */
export function useSetStatus() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const setStatus = async (row: TrackerRow, state: string, opts: { note?: string; okText?: string } = {}): Promise<boolean> => {
    setBusy(true);
    setMessage(null);
    try {
      await apiSend('POST', '/api/actions/tracker.setStatus', { params: { row: row.num, state, ...(opts.note ? { note: opts.note } : {}) } });
      setMessage(opts.okText ?? `Status set to ${state}`);
      await qc.invalidateQueries({ queryKey: ['tracker'] });
      return true;
    } catch (err) {
      setMessage(`Could not set status: ${describeError(err)}`);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { setStatus, busy, message };
}

export function StatusMessage({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="status" className={message.startsWith('Could not') ? 'danger-text' : 'muted'}>
      {message}
    </p>
  );
}

/** Discarded and SKIP need a reason (TUI parity); it is committed as a `DISCARD: reason` note. */
export function DiscardReasonPicker({ state, row, busy, onConfirm, onCancel }: { state: string; row: TrackerRow; busy: boolean; onConfirm: (note: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const [otherText, setOtherText] = useState('');
  const predicted = row.summary?.discardReasons ?? [];
  const reasons = [...new Set([...predicted, ...DISCARD_REASONS])];
  const chosenReason = reason === '__other' ? otherText.trim() : reason;
  return (
    <div className="card" role="dialog" aria-label="Discard reason picker">
      <p className="muted">Why {state === 'SKIP' ? 'skip' : 'discard'} this one?</p>
      <select aria-label="Discard reason" value={reason} onChange={(e) => setReason(e.target.value)}>
        <option value="">Pick a reason</option>
        {reasons.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
        <option value="__other">Other</option>
      </select>
      {reason === '__other' && <input aria-label="Other reason" placeholder="Reason" value={otherText} onChange={(e) => setOtherText(e.target.value)} />}
      <div className="row gap" style={{ marginTop: 8 }}>
        <button type="button" disabled={!chosenReason || busy} onClick={() => onConfirm(`DISCARD: ${chosenReason}`)}>
          Confirm {state}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Status picker with the current status first; Discarded and SKIP ask for a reason (TUI parity). */
export function StatusControl({ row }: { row: TrackerRow }) {
  const { setStatus, busy, message } = useSetStatus();
  const [pending, setPending] = useState<string | null>(null);
  const [hired, setHired] = useState(false);
  const ordered = [row.status, ...STATES.filter((s) => s !== row.status)];

  const commit = async (state: string, note?: string) => {
    if (!(await setStatus(row, state, { note }))) return;
    if (state === 'Hired' && row.report !== null) setHired(true);
    setPending(null);
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      <label className="row gap">
        <span className="muted">Status</span>
        <select
          aria-label="Change status"
          value={pending ?? row.status}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.value;
            if (next === row.status) return setPending(null);
            if (next === 'Discarded' || next === 'SKIP') setPending(next);
            else void commit(next);
          }}
        >
          {ordered.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      {pending && <DiscardReasonPicker state={pending} row={row} busy={busy} onConfirm={(note) => void commit(pending, note)} onCancel={() => setPending(null)} />}
      <StatusMessage message={message} />
      {hired && row.report !== null && <HiredDialog report={row.report} company={row.company} onClose={() => setHired(false)} />}
    </div>
  );
}

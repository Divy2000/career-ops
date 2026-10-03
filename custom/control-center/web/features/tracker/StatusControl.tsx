import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiSend, type ApiError } from '../../lib/api';
import type { TrackerRow } from '@shared/api';

export const STATES = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP'] as const;
export const DISCARD_REASONS = ['comp below floor', 'no visa sponsorship', 'location mismatch', 'level mismatch', 'staffing agency', 'posting closed', 'culture concerns'];

/** Status picker with the current status first; Discarded and SKIP ask for a reason (TUI parity). */
export function StatusControl({ row }: { row: TrackerRow }) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ordered = [row.status, ...STATES.filter((s) => s !== row.status)];
  const predicted = row.summary?.discardReasons ?? [];
  const reasons = [...new Set([...predicted, ...DISCARD_REASONS])];

  const commit = async (state: string, note?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await apiSend('POST', '/api/actions/tracker.setStatus', { params: { row: row.num, state, ...(note ? { note } : {}) } });
      setMessage(`Status set to ${state}`);
      setPending(null);
      setReason('');
      await qc.invalidateQueries({ queryKey: ['tracker'] });
    } catch (err) {
      const e = err as ApiError;
      const body = e.body as { error?: string; stderr?: string } | null;
      setMessage(`Could not set status: ${body?.error ?? e.message}${body?.stderr ? ` (${body.stderr.trim().slice(-200)})` : ''}`);
    } finally {
      setBusy(false);
    }
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
      {pending && (
        <div className="card" role="dialog" aria-label="Discard reason picker">
          <p className="muted">Why {pending === 'SKIP' ? 'skip' : 'discard'} this one?</p>
          <select aria-label="Discard reason" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">Pick a reason</option>
            {reasons.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
            <option value="__other">Other</option>
          </select>
          {reason === '__other' && <input aria-label="Other reason" placeholder="Reason" onChange={(e) => setReason(e.target.value ? `other: ${e.target.value}` : '__other')} />}
          <div className="row gap" style={{ marginTop: 8 }}>
            <button type="button" disabled={!reason || reason === '__other' || busy} onClick={() => void commit(pending, `DISCARD: ${reason.replace(/^other: /, '')}`)}>
              Confirm {pending}
            </button>
            <button type="button" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {message && (
        <p role="status" className={message.startsWith('Could not') ? 'danger-text' : 'muted'}>
          {message}
        </p>
      )}
    </div>
  );
}

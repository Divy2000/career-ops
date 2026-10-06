import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { apiSend } from '../../lib/api';
import { describeError } from '../../lib/actions';

/** Two-step delete: dry-run preview first, then the real tracker.mjs delete. */
export function DangerZone({ n }: { n: number }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const call = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    try {
      // "Confirm delete" is the user's confirmation, which the real delete must carry; the dry run needs none.
      const r = await apiSend<{ result: unknown; stderr?: string }>('POST', '/api/actions/tracker.delete', dryRun ? { params: { n, dryRun } } : { params: { n, dryRun }, confirmed: true });
      const text = `${typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2)}\n${r.stderr ?? ''}`.trim();
      if (dryRun) setPreview(text || 'Dry run produced no output.');
      else {
        await qc.invalidateQueries({ queryKey: ['tracker'] });
        await navigate({ to: '/tracker' });
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card stack">
      <h2 className="danger-text">Danger zone</h2>
      <p className="muted">Deleting removes this row from applications.md and reindexes. The report file stays on disk as an orphan.</p>
      <div className="row gap">
        <button type="button" disabled={busy} onClick={() => void call(true)}>
          Preview delete (dry run)
        </button>
        {preview !== null && (
          <button type="button" disabled={busy} onClick={() => void call(false)}>
            Confirm delete #{n}
          </button>
        )}
      </div>
      {preview !== null && (
        <pre className="log" aria-label="Delete preview" tabIndex={0}>
          {preview}
        </pre>
      )}
      {error && (
        <p role="alert" className="danger-text">
          {error}
        </p>
      )}
    </div>
  );
}

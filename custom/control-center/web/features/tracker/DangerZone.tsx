import { useState, useSyncExternalStore } from 'react';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { ApplicationDetail } from '@shared/api';
import { apiSend } from '../../lib/api';
import { describeError } from '../../lib/actions';

type RowIdentity = { company: string; role: string; report: number | null };
const sameRow = (a: RowIdentity | null, b: RowIdentity | null) => a?.company === b?.company && a?.role === b?.role && a?.report === b?.report;

/** Two-step delete: dry-run preview first, then the real tracker.mjs delete. */
export function DangerZone({ n }: { n: number }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const router = useRouter();
  // The row the page shows under n. A number a delete frees can be reused by a later merge, so a preview belongs to the
  // row it was taken for and the confirm names that row for the server to check. Read from the page's cache without an
  // observer of its own, which would rebuild the row query the delete removes.
  const shown = useSyncExternalStore(
    (onChange) => qc.getQueryCache().subscribe(onChange),
    () => qc.getQueryData<ApplicationDetail>(['tracker', 'row', String(n)])?.row,
  );
  const identity: RowIdentity | null = shown ? { company: shown.company, role: shown.role, report: shown.report } : null;
  const [taken, setPreview] = useState<{ text: string; of: RowIdentity | null } | null>(null);
  const preview = taken && sameRow(taken.of, identity) ? taken.text : null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const call = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    // The delete waits on the tracker lock, so it can answer after the user left this row's page: only a user still on
    // it (on any tab) is moved off the deleted row.
    const page = router.state.location.pathname;
    try {
      // "Confirm delete" is the user's confirmation, which the real delete must carry; the dry run needs none.
      const expected = dryRun ? null : (taken?.of ?? null);
      const params = expected
        ? { n, dryRun, expectCompany: expected.company, expectRole: expected.role, expectReport: expected.report }
        : { n, dryRun };
      const r = await apiSend<{ result: unknown; stderr?: string }>('POST', '/api/actions/tracker.delete', dryRun ? { params } : { params, confirmed: true });
      const text = `${typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2)}\n${r.stderr ?? ''}`.trim();
      if (dryRun) setPreview({ text: text || 'Dry run produced no output.', of: identity });
      else {
        // The row is gone: its own queries would refetch into a 404 and hold the page on their retries. Drop them,
        // leave, then refresh the tracker lists.
        qc.removeQueries({ queryKey: ['tracker', 'row', String(n)] });
        qc.removeQueries({ queryKey: ['tracker', 'documents', n] });
        if (router.state.location.pathname === page) await navigate({ to: '/tracker' });
        await qc.invalidateQueries({ queryKey: ['tracker'] });
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

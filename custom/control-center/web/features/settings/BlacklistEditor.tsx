import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiGet, apiSend, ApiError } from '../../lib/api';
import { describeError } from '../../lib/actions';
import { useConfirm } from '../../components/ConfirmDialog';
import { DataState, Empty, Pill } from '../../components/ui';
import type { BlacklistRead, BlacklistRow } from '@shared/api';

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The only place that writes data/blacklist.md. Saving opens an explicit confirm
 * dialog; the PUT carries {confirm:true} and X-CC-Explicit: blacklist, which the
 * server requires (403 otherwise). Sessions can never write this file.
 */
export function BlacklistEditor({ prefillCompany }: { prefillCompany?: string }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['config', 'blacklist'], queryFn: () => apiGet<BlacklistRead>('/api/blacklist') });
  const [rows, setRows] = useState<BlacklistRow[] | null>(null);
  const [draft, setDraft] = useState<BlacklistRow>({ company: prefillCompany ?? '', since: today(), scope: 'company', reason: '' });
  const [note, setNote] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const current = rows ?? q.data?.rows ?? [];
  const dirty = rows !== null;
  const addRow = () => {
    if (!draft.company.trim()) return;
    if (draft.scope === 'domain' && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(draft.company.trim())) {
      setNote({ tone: 'danger', text: 'Domain scope needs a bare hostname suffix such as example.com.' });
      return;
    }
    setNote(null);
    setRows([...current, { ...draft, company: draft.company.trim(), reason: draft.reason.trim() }]);
    setDraft({ company: '', since: today(), scope: 'company', reason: '' });
  };
  const save = async () => {
    const added = current.length - (q.data?.rows.length ?? 0);
    const ok = await confirm({
      title: 'Write data/blacklist.md?',
      body: (
        <>
          <p>
            {current.length} row{current.length === 1 ? '' : 's'} will be written ({added >= 0 ? `${added} added` : `${-added} removed`}). The scanner skips every listed company and domain on its next run.
          </p>
          <p>This is the only way the app writes the blacklist; AI sessions are denied this file.</p>
        </>
      ),
      confirmLabel: 'Write blacklist',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiSend('PUT', '/api/blacklist', { confirm: true, rows: current }, { 'X-CC-Explicit': 'blacklist', ...(q.data?.etag ? { 'If-Match': q.data.etag } : {}) });
      setRows(null);
      setNote({ tone: 'ok', text: 'Blacklist written.' });
      toast.success('Blacklist written');
      await qc.invalidateQueries({ queryKey: ['config'] });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await qc.invalidateQueries({ queryKey: ['config', 'blacklist'] });
        setNote({ tone: 'danger', text: 'data/blacklist.md changed on disk; the current rows were reloaded. Re-add your rows and save again.' });
        setRows(null);
      } else setNote({ tone: 'danger', text: `Could not write the blacklist: ${describeError(err)}` });
      toast.error('Blacklist not written');
    }
  };
  return (
    <div className="card" aria-labelledby="blacklist-heading">
      <div className="row gap" style={{ justifyContent: 'space-between' }}>
        <h2 id="blacklist-heading" style={{ margin: 0 }}>
          Blacklist {q.data?.kind === 'missing' && <Pill tone="warn">data/blacklist.md not created yet</Pill>}
        </h2>
        <div className="row gap">
          <button type="button" className="button--ghost" disabled={!dirty} onClick={() => setRows(null)}>
            Discard
          </button>
          <button type="button" className="button--danger" disabled={!dirty} onClick={() => void save()}>
            Save blacklist
          </button>
        </div>
      </div>
      <p className="muted small">Format follows templates/blacklist.example.md: Company, Since, Scope (company or domain), Reason. Nothing is written until you confirm.</p>
      <DataState query={q}>
        {current.length === 0 ? (
          <Empty>No blacklisted companies. Add one below.</Empty>
        ) : (
          <div className="table-scroll">
            <table className="table table--compact" aria-label="Blacklist rows">
              <thead>
                <tr>
                  <th scope="col">Company</th>
                  <th scope="col">Since</th>
                  <th scope="col">Scope</th>
                  <th scope="col">Reason</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {current.map((r, i) => (
                  <tr key={`${r.company}-${i}`}>
                    <td>{r.company}</td>
                    <td className="mono">{r.since}</td>
                    <td>
                      <Pill tone={r.scope === 'domain' ? 'info' : 'neutral'}>{r.scope}</Pill>
                    </td>
                    <td className="muted">{r.reason}</td>
                    <td>
                      <button type="button" className="button--ghost" aria-label={`Remove ${r.company} from the blacklist draft`} onClick={() => setRows(current.filter((_, j) => j !== i))}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row gap" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <input aria-label="Blacklist company or domain" placeholder="Company or domain" value={draft.company} onChange={(e) => setDraft({ ...draft, company: e.target.value })} />
          <input aria-label="Blacklist since" type="date" value={draft.since} onChange={(e) => setDraft({ ...draft, since: e.target.value })} />
          <select aria-label="Blacklist scope" value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value as BlacklistRow['scope'] })}>
            <option value="company">company</option>
            <option value="domain">domain</option>
          </select>
          <input aria-label="Blacklist reason" placeholder="Reason" value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
          <button type="button" onClick={addRow} disabled={!draft.company.trim()}>
            Add row
          </button>
        </div>
        {note && (
          <p role={note.tone === 'danger' ? 'alert' : 'status'} className={note.tone === 'danger' ? 'danger-text' : 'muted'}>
            {note.text}
          </p>
        )}
      </DataState>
    </div>
  );
}

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiGet, apiSend, ApiError } from '../../lib/api';
import { DataState, Pill } from '../../components/ui';
import type { ConfigRead } from '@shared/api';

/** Raw YAML editor gated by the core validator; a 422 shows the findings and writes nothing, a 409 shows the current text for a manual merge. */
export function ConfigEditor({ fileKey, label, validator }: { fileKey: 'portals' | 'profile'; label: string; validator: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['config', fileKey], queryFn: () => apiGet<ConfigRead>(`/api/config/${fileKey}`) });
  const [draft, setDraft] = useState<string | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'danger'; text: string; details?: string } | null>(null);
  const raw = draft ?? q.data?.raw ?? '';
  const currentEtag = etag ?? q.data?.etag ?? null;
  const save = async () => {
    setNote(null);
    try {
      const r = await apiSend<{ etag: string; warnings: unknown }>('PUT', `/api/config/${fileKey}`, { raw }, currentEtag ? { 'If-Match': currentEtag } : {});
      setEtag(r.etag);
      setDraft(null);
      const warnings = typeof r.warnings === 'string' ? r.warnings : JSON.stringify(r.warnings, null, 2);
      setNote({ tone: 'ok', text: `Saved ${label} (validated by ${validator}).`, details: warnings && warnings !== '""' ? warnings : undefined });
      toast.success(`Saved ${label}`);
      await qc.invalidateQueries({ queryKey: ['config'] });
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        const b = err.body as { error: string; findings: unknown; stderr: string };
        setNote({ tone: 'danger', text: b.error, details: `${typeof b.findings === 'string' ? b.findings : JSON.stringify(b.findings, null, 2)}\n${b.stderr ?? ''}`.trim() });
      } else if (err instanceof ApiError && err.status === 409) {
        const b = err.body as { current: ConfigRead };
        setEtag(b.current.etag);
        setNote({ tone: 'danger', text: 'The file changed on disk since you loaded it. Save again to overwrite it, or copy your edits from this box into the current version below.', details: b.current.raw });
      } else setNote({ tone: 'danger', text: `Could not save: ${(err as Error).message}` });
      toast.error(`Could not save ${label}`);
    }
  };
  return (
    <div className="card">
      <div className="row gap" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>
          {label} {q.data?.kind === 'missing' && <Pill tone="warn">not created yet</Pill>} <Pill>validated by {validator}</Pill>
        </h2>
        <button type="button" onClick={() => void save()} disabled={!q.data || raw === q.data.raw}>
          Validate and save
        </button>
      </div>
      <p className="muted small">Raw YAML. Comments are kept as typed. The structured tab edits the same file through comment-preserving operations.</p>
      <DataState query={q}>
        <textarea aria-label={`${label} YAML`} className="mono editor" rows={22} value={raw} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
      </DataState>
      {note && (
        <div role={note.tone === 'danger' ? 'alert' : 'status'} className={note.tone === 'danger' ? 'danger-text' : 'muted'}>
          {note.text}
          {note.details && <pre tabIndex={0} className="log mono small">{note.details}</pre>}
        </div>
      )}
    </div>
  );
}

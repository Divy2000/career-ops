import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiGet, apiSend, ApiError } from '../../lib/api';
import { applyOpsJs } from '../../lib/yamlOpsClient';
import { useEditBase } from '../../lib/editBase';
import type { ConfigRead, YamlOp } from '@shared/api';

export interface EditorNote {
  tone: 'ok' | 'danger';
  text: string;
  details?: string;
}

/**
 * Pending ops over a config file, applied to the version the first op was made on: a refetch after a change on
 * disk never moves them onto another version silently (index-based ops would land on other items), it is announced
 * and the save gets the 409. A 409 swaps the base for the server's current version and keeps the ops that address
 * keys on top, so "save again" is the merge. Ops that address a list item by position are dropped there: replayed on
 * a list another writer changed they would edit or delete someone else's item, so the user redoes them.
 */
const byPosition = (op: YamlOp) => op.path.some((seg) => typeof seg === 'number');

export function useStructuredConfig(fileKey: 'portals' | 'profile') {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['config', fileKey], queryFn: () => apiGet<ConfigRead>(`/api/config/${fileKey}`) });
  const [pending, setPending] = useState<YamlOp[]>([]);
  const [conflict, setConflict] = useState<ConfigRead | null>(null);
  const [note, setNote] = useState<EditorNote | null>(null);
  const [saving, setSaving] = useState(false);
  const edit = useEditBase(q.data);
  const server = edit.base ?? q.data ?? null;
  const doc = useMemo(() => applyOpsJs(server?.doc ?? null, pending), [server, pending]);
  const addOp = (op: YamlOp) => {
    edit.pin();
    setPending((p) => [...p, op]);
  };
  const discard = () => {
    setPending([]);
    setConflict(null);
    setNote(null);
    edit.rebase(null);
  };
  const save = async () => {
    if (pending.length === 0) return;
    setSaving(true);
    setNote(null);
    try {
      const etag = server?.etag ?? null;
      const r = await apiSend<{ etag: string; warnings: unknown }>('PUT', `/api/config/${fileKey}`, { ops: pending }, etag ? { 'If-Match': etag } : {});
      const warnings = typeof r.warnings === 'string' ? r.warnings : JSON.stringify(r.warnings, null, 2);
      setPending([]);
      setConflict(null);
      edit.rebase(null);
      setNote({ tone: 'ok', text: `Saved ${server?.path ?? fileKey} (${pending.length} change${pending.length === 1 ? '' : 's'}, validated).`, details: warnings && warnings !== '""' ? warnings : undefined });
      toast.success(`Saved ${server?.path ?? fileKey}`);
      await qc.invalidateQueries({ queryKey: ['config'] });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const current = (err.body as { current: ConfigRead }).current;
        const kept = pending.filter((op) => !byPosition(op));
        const dropped = pending.length - kept.length;
        setConflict(current);
        edit.rebase(current);
        setPending(kept);
        const redo = dropped === 0 ? '' : ` ${dropped} edit${dropped === 1 ? '' : 's'} to a list item ${dropped === 1 ? 'was' : 'were'} dropped because the list changed; redo ${dropped === 1 ? 'it' : 'them'} on the current version.`;
        setNote({ tone: 'danger', text: `${current.path} changed on disk since you loaded it. Your ${kept.length} pending edit(s) are shown on top of the current version below; review them, then save again or discard.${redo}` });
      } else if (err instanceof ApiError && (err.status === 422 || err.status === 400)) {
        const b = err.body as { error: string; findings?: unknown; stderr?: string };
        setNote({ tone: 'danger', text: b.error, details: `${typeof b.findings === 'string' ? b.findings : JSON.stringify(b.findings ?? '', null, 2)}\n${b.stderr ?? ''}`.trim() });
      } else setNote({ tone: 'danger', text: `Could not save: ${(err as Error).message}` });
      toast.error('Save failed');
    } finally {
      setSaving(false);
    }
  };
  const drift: EditorNote | null =
    edit.drifted && pending.length > 0 ? { tone: 'danger', text: `${server?.path ?? fileKey} changed on disk since you started editing. Your ${pending.length} pending edit(s) still apply to the version you loaded; save to see the current version, or discard.` } : null;
  return { q, server, doc, pending, conflict, note: note ?? drift, saving, addOp, save, discard, setNote };
}

export function EditorNoteView({ note }: { note: EditorNote | null }) {
  if (!note) return null;
  return (
    <div role={note.tone === 'danger' ? 'alert' : 'status'} className={note.tone === 'danger' ? 'danger-text' : 'muted'}>
      {note.text}
      {note.details && <pre tabIndex={0} className="log mono small">{note.details}</pre>}
    </div>
  );
}

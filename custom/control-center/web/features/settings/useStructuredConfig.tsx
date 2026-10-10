import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiGet, apiSend, ApiError } from '../../lib/api';
import { applyOpsJs } from '../../lib/yamlOpsClient';
import { useEditBase } from '../../lib/editBase';
import { useUnsaved } from '../../lib/unsaved';
import type { ConfigRead, YamlOp } from '@shared/api';
import { describeError } from '../../lib/actions';

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
 * a list another writer changed they would edit or delete someone else's item, so the user redoes them. So is a set
 * or delete whose target another writer changed: "Add tracked_companies" would replace the companies they wrote.
 * An insert only appends, so it is kept.
 */
const byPosition = (op: YamlOp) => op.path.some((seg) => typeof seg === 'number');
const valueAt = (doc: unknown, path: YamlOp['path']): unknown => path.reduce<unknown>((node, seg) => (node !== null && typeof node === 'object' ? (node as Record<string | number, unknown>)[seg] : undefined), doc);
const changedOnDisk = (op: YamlOp, base: unknown, current: unknown) => op.op !== 'insert' && JSON.stringify(valueAt(base, op.path)) !== JSON.stringify(valueAt(current, op.path));
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function useStructuredConfig(fileKey: 'portals' | 'profile') {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['config', fileKey], queryFn: () => apiGet<ConfigRead>(`/api/config/${fileKey}`) });
  const [pending, setPendingState] = useState<YamlOp[]>([]);
  // The ops as last edited, read when a save answers: ops added while it was on its way were not sent and stay pending.
  const latest = useRef<YamlOp[]>([]);
  const setPending = (next: YamlOp[]) => {
    latest.current = next;
    setPendingState(next);
  };
  const [conflict, setConflict] = useState<ConfigRead | null>(null);
  const [note, setNote] = useState<EditorNote | null>(null);
  const [saving, setSaving] = useState(false);
  const edit = useEditBase(q.data);
  useUnsaved(fileKey === 'portals' ? 'portals.yml' : 'config/profile.yml', pending.length > 0);
  const server = edit.base ?? q.data ?? null;
  const doc = useMemo(() => applyOpsJs(server?.doc ?? null, pending), [server, pending]);
  const addOp = (op: YamlOp) => {
    edit.pin();
    setPending([...latest.current, op]);
  };
  const discard = () => {
    setPending([]);
    setConflict(null);
    setNote(null);
    edit.rebase(null);
  };
  const save = async () => {
    const sent = latest.current;
    if (sent.length === 0 || saving) return;
    setSaving(true);
    setNote(null);
    try {
      const etag = server?.etag ?? null;
      const r = await apiSend<{ etag: string; warnings: unknown }>('PUT', `/api/config/${fileKey}`, { ops: sent }, etag ? { 'If-Match': etag } : {});
      const warnings = typeof r.warnings === 'string' ? r.warnings : JSON.stringify(r.warnings, null, 2);
      const rest = latest.current.slice(sent.length);
      setPending(rest);
      setConflict(null);
      // Ops added meanwhile were made on top of the sent ones, which is the version just written.
      edit.rebase(rest.length > 0 && server ? { ...server, doc: applyOpsJs(server.doc, sent), etag: r.etag } : null);
      setNote({ tone: 'ok', text: `Saved ${server?.path ?? fileKey} (${sent.length} change${sent.length === 1 ? '' : 's'}, validated).`, details: warnings && warnings !== '""' ? warnings : undefined });
      toast.success(`Saved ${server?.path ?? fileKey}`);
      await qc.invalidateQueries({ queryKey: ['config'] });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const current = (err.body as { current: ConfigRead }).current;
        const all = latest.current;
        const positional = all.filter(byPosition);
        const overwritten = all.filter((op) => !byPosition(op) && changedOnDisk(op, server?.doc ?? null, current.doc));
        const kept = all.filter((op) => !positional.includes(op) && !overwritten.includes(op));
        setConflict(current);
        edit.rebase(current);
        setPending(kept);
        const p = positional.length;
        const o = overwritten.length;
        const redo =
          (p === 0 ? '' : ` ${p} ${plural(p, 'edit', 'edits')} to a list item ${plural(p, 'was', 'were')} dropped because the list changed; redo ${plural(p, 'it', 'them')} on the current version.`) +
          (o === 0 ? '' : ` ${o} ${plural(o, 'edit', 'edits')} to a value that also changed on disk ${plural(o, 'was', 'were')} dropped; redo ${plural(o, 'it', 'them')} on the current version.`);
        setNote({ tone: 'danger', text: `${current.path} changed on disk since you loaded it. Your ${kept.length} pending edit(s) are shown on top of the current version below; review them, then save again or discard.${redo}` });
      } else if (err instanceof ApiError && (err.status === 422 || err.status === 400)) {
        const b = err.body as { error: string; findings?: unknown; stderr?: string };
        setNote({ tone: 'danger', text: b.error, details: `${typeof b.findings === 'string' ? b.findings : JSON.stringify(b.findings ?? '', null, 2)}\n${b.stderr ?? ''}`.trim() });
      } else setNote({ tone: 'danger', text: `Could not save: ${describeError(err)}` });
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

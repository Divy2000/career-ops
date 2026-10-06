// Profile > Projects: the projects library (article-digest.md) as a list with
// badges, a one-entry form, validation, import (paste, file, or a read-only
// parser session for PDF) and a rank preview against a pasted JD.
import { useCallback, useMemo, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { apiGet, apiSend, ApiError } from '../../lib/api';
import { describeError } from '../../lib/actions';
import { useConfirm } from '../../components/ConfirmDialog';
import { SessionPanel } from '../../components/SessionPanel';
import { DataState, Empty, FilePicker, Pill } from '../../components/ui';
import type { ConvertResult, ProjectView, ProjectsRead, RankResult } from '@shared/api';
import { KIND_OPTIONS, describeIssues, draftFromEntry, draftProblems, emptyDraft, entryFromDraft, findRenamed, hostOf, moveItem, rebaseDraft, type DraftField, type EntryOrigin, type ProjectDraft } from './projectsDraft';

const QUERY_KEY = ['config', 'projects'];
const useProjects = () => useQuery({ queryKey: QUERY_KEY, queryFn: () => apiGet<ProjectsRead>('/api/projects') });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ifMatch = (etag: string | null | undefined): Record<string, string> => (etag ? { 'If-Match': etag } : {});

interface Editing {
  id: string | null;
  draft: ProjectDraft;
  /** The entry as the form opened on it (or last rebased on): what the user's edits are measured against after a 409. */
  base: ProjectDraft;
  tagline: string | null;
  source: string | null;
  /** The library version the form opened on: the save sends it, so a change on disk meanwhile gets the 409, not an overwrite. */
  baseEtag: string | null;
  /** Where the entry was when the form opened (null for a new project), to tell a rename on disk from a removal. */
  origin: EntryOrigin | null;
  /** Problems and conflict notes. Kept here, not in the form, so they survive the form moving in the list. */
  messages: string[];
  /** After a 409 where both sides changed a field: the version on disk of those fields, shown beside the draft. */
  onDisk: { fields: DraftField[]; entry: ProjectDraft } | null;
  /** The entry was renamed or removed on disk beyond recognition: Save has nothing to update, only "Save as new project". */
  orphaned: boolean;
}

const FIELD_LABELS: Record<DraftField, string> = { title: 'Title', url: 'Link', tags: 'Tags', kind: 'Kind', dates: 'Dates', bullets: 'Bullets' };
const fieldLabel = (f: DraftField) => FIELD_LABELS[f];

const newEditing = (fields: Pick<Editing, 'id' | 'draft' | 'tagline' | 'source' | 'baseEtag' | 'origin'>): Editing => ({ ...fields, base: fields.draft, messages: [], onDisk: null, orphaned: false });

/** The form rebased on the library as it is now after a 409, so a second save never quietly undoes another writer's edit. */
function rebaseOn(e: Editing, fresh: ProjectsRead): Editing {
  const next = { ...e, baseEtag: fresh.etag, onDisk: null };
  if (e.id === null) return { ...next, messages: ['article-digest.md changed on disk since it was loaded. The list is refreshed; save again to add this project.'] };
  const byId = fresh.entries.find((x) => x.id === e.id);
  const now = byId ?? (e.origin ? findRenamed(e.origin, fresh.entries) : null);
  if (!now) {
    return { ...next, orphaned: true, messages: ['article-digest.md changed on disk and this entry was renamed or removed on disk, so Save project has nothing to update. "Save as new project" adds your draft as a new entry; Cancel drops it. The entries on disk now are listed below.'] };
  }
  const current = draftFromEntry(now);
  const merged = rebaseDraft(e.base, e.draft, current);
  const renamed = byId ? '' : `It was renamed on disk to "${now.title}". `;
  return {
    ...next,
    id: now.id,
    orphaned: false,
    draft: merged.draft,
    base: current,
    tagline: now.tagline,
    source: now.source,
    origin: { ids: fresh.entries.map((x) => x.id), index: fresh.entries.indexOf(now), bullets: now.bullets },
    onDisk: merged.conflicts.length ? { fields: merged.conflicts, entry: current } : null,
    messages: [
      merged.conflicts.length
        ? `article-digest.md changed on disk since it was loaded. ${renamed}${merged.conflicts.map(fieldLabel).join(', ')} changed both here and on disk: the form keeps yours, the version on disk is shown below. Save again to replace it, or Cancel.`
        : `article-digest.md changed on disk since it was loaded. ${renamed}Its changes to this entry are now in the form, with yours on top; review them, then save again.`,
    ],
  };
}

export function ProjectsLibrary() {
  const q = useProjects();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Editing | null>(null);
  const data = q.data;
  // A form left with nothing to update (its entry renamed or removed on disk) is rebased again on every new version of
  // the library, so it picks the entry back up when a rewrite in two steps restores it. Adjusted while rendering.
  const [seenEtag, setSeenEtag] = useState<string | null | undefined>(undefined);
  if (data && data.etag !== seenEtag) {
    setSeenEtag(data.etag);
    if (editing?.orphaned) setEditing(rebaseOn(editing, data));
  }
  const refresh = () => qc.invalidateQueries({ queryKey: QUERY_KEY });

  const remove = async (entry: ProjectView) => {
    const ok = await confirm({ title: `Delete ${entry.title}?`, body: 'Removes the entry from article-digest.md. cv.md is not changed.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await apiSend('DELETE', `/api/projects/${entry.id}`, {}, ifMatch(data?.etag));
      toast.success(`Deleted ${entry.title}`);
    } catch (err) {
      toast.error(`Could not delete ${entry.title}: ${describeError(err)}`);
    }
    await refresh();
  };

  const projects = data?.entries.filter((e) => e.kind === 'project').length ?? 0;
  const others = (data?.entries.length ?? 0) - projects;
  const inCv = data?.entries.filter((e) => e.inCv).length ?? 0;

  return (
    <div className="stack">
      <div className="card">
        <div className="projects-head">
          <div>
            <h2>Projects library</h2>
            <p className="muted small projects-head__lede">
              <span className="mono">article-digest.md</span>: every project with copy-paste bullets. Tailored CVs pick 2 to 4 from here.
            </p>
          </div>
          <button type="button" className="button--primary" disabled={!data || editing !== null} title={editing ? 'Save or cancel the open form first' : undefined} onClick={() => setEditing(newEditing({ id: null, draft: emptyDraft(), tagline: null, source: null, baseEtag: data?.etag ?? null, origin: null }))}>
            <Plus size={16} aria-hidden="true" /> Add project
          </button>
        </div>
        {data && data.entries.length > 0 && (
          <div className="row gap projects-counts">
            <Pill>{plural(projects, 'project')}</Pill>
            {others > 0 && <Pill tone="info">{plural(others, 'paper or article')}</Pill>}
            <Pill tone={inCv > 0 ? 'ok' : 'neutral'}>{inCv} in cv.md</Pill>
          </div>
        )}
        <DataState query={q} editable>
          {data && <ValidationPanel validation={data.validation} />}
          {/* A new project, or an entry removed on disk while its form was open: the form stays up, above the list. */}
          {editing && (editing.id === null || !data?.entries.some((e) => e.id === editing.id)) && <ProjectForm editing={editing} liveEtag={data?.etag ?? null} onDiskTitles={data?.entries.map((e) => e.title) ?? []} update={setEditing} onDone={() => setEditing(null)} />}
          {data && data.entries.length === 0 && editing === null && (
            <Empty>{data.kind === 'missing' ? 'No article-digest.md yet. Add a project or import a list below; the file is created on the first save.' : 'The library has no entries yet.'}</Empty>
          )}
          {data && data.entries.length > 0 && (
            <ul className="project-list" aria-label="Projects in the library">
              {data.entries.map((entry) =>
                editing?.id === entry.id ? (
                  <li key={entry.id} className="project-row project-row--editing">
                    <ProjectForm editing={editing} liveEtag={data.etag} onDiskTitles={data.entries.map((e) => e.title)} update={setEditing} onDone={() => setEditing(null)} />
                  </li>
                ) : (
                  <ProjectRow key={entry.id} entry={entry} disabled={editing !== null} onEdit={() => setEditing(newEditing({ id: entry.id, draft: draftFromEntry(entry), tagline: entry.tagline, source: entry.source, baseEtag: data.etag, origin: { ids: data.entries.map((e) => e.id), index: data.entries.indexOf(entry), bullets: entry.bullets } }))} onDelete={() => void remove(entry)} />
                ),
              )}
            </ul>
          )}
        </DataState>
      </div>
      <ProjectsImport etag={data?.etag ?? null} onAppended={() => void refresh()} />
      <RankPreview />
    </div>
  );
}

function ValidationPanel({ validation }: { validation: ProjectsRead['validation'] }) {
  if (validation.ok && validation.warnings.length === 0) return null;
  return (
    <div className={`projects-check ${validation.ok ? 'projects-check--warn' : 'projects-check--danger'}`} role={validation.ok ? 'status' : 'alert'}>
      <strong>{validation.ok ? 'Library warnings' : 'The library has errors'}</strong>
      <ul>
        {[...validation.errors, ...validation.warnings].map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
    </div>
  );
}

function ProjectRow({ entry, disabled, onEdit, onDelete }: { entry: ProjectView; disabled: boolean; onEdit: () => void; onDelete: () => void }) {
  const host = hostOf(entry.url);
  return (
    <li className="project-row">
      <div className="project-row__main">
        <h3 className="project-row__title">
          {entry.url ? <a href={entry.url}>{entry.title}</a> : entry.title}
          {entry.tagline && <span className="project-row__tagline"> {entry.tagline}</span>}
        </h3>
        <div className="project-row__meta">
          {entry.inCv && <Pill tone="ok">In CV</Pill>}
          {entry.kind !== 'project' && <Pill tone="info">{KIND_OPTIONS.find((k) => k.value === entry.kind)?.label ?? entry.kind}</Pill>}
          <Pill>{plural(entry.bullets.length, 'bullet')}</Pill>
          {host && <Pill title={entry.url ?? undefined}>{host}</Pill>}
          {entry.source && <Pill title={`Imported from ${entry.source}`}>from {entry.source.split('/').pop()}</Pill>}
          {entry.dates && <span className="faint small">{entry.dates}</span>}
        </div>
        {entry.bullets.length > 0 && (
          <ul className="project-row__bullets">
            {entry.bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        )}
        {entry.tags.length > 0 && (
          <div className="project-row__tags" aria-label={`Tags for ${entry.title}`}>
            {entry.tags.map((t) => (
              <span key={t} className="project-tag mono">
                {t}
              </span>
            ))}
          </div>
        )}
        {entry.editProblem && (
          <p className="project-row__locked small" role="note">
            Read-only here: {entry.editProblem}.
          </p>
        )}
      </div>
      <div className="project-row__actions">
        <button type="button" aria-label={`Edit ${entry.title}`} disabled={disabled || entry.editProblem !== null} title={entry.editProblem ? 'This entry has content the form cannot keep; edit article-digest.md directly' : undefined} onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="button--ghost" aria-label={`Delete ${entry.title}`} disabled={disabled} onClick={onDelete}>
          Delete
        </button>
      </div>
    </li>
  );
}

function ProjectForm({ editing, liveEtag, onDiskTitles, update, onDone }: { editing: Editing; liveEtag: string | null; onDiskTitles: string[]; update: Dispatch<SetStateAction<Editing | null>>; onDone: () => void }) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const { draft, messages, onDisk } = editing;
  // Every change goes through the latest state: typing during a save is not overwritten by what the save captured.
  const patch = (fn: (e: Editing) => Editing) => update((prev) => (prev ? fn(prev) : prev));
  const set = (p: Partial<ProjectDraft>) => patch((e) => ({ ...e, draft: { ...e.draft, ...p } }));
  const setBullet = (i: number, value: string) => patch((e) => ({ ...e, draft: { ...e.draft, bullets: e.draft.bullets.map((b, j) => (j === i ? value : b)) } }));
  const say = (m: string[]) => patch((e) => ({ ...e, messages: m }));
  const label = editing.id === null ? 'Add a project' : `Edit ${draft.title || 'project'}`;

  const save = async (asNew: boolean) => {
    const problems = draftProblems(draft);
    say(problems);
    if (problems.length) return;
    // Only the explicit "Save as new project" adds an entry the form was editing.
    if (editing.orphaned && !asNew) return;
    setSaving(true);
    try {
      const body = entryFromDraft(draft, { tagline: editing.tagline, source: editing.source });
      if (editing.id === null || asNew) await apiSend('POST', '/api/projects', body, ifMatch(editing.baseEtag));
      else await apiSend('PUT', `/api/projects/${editing.id}`, body, ifMatch(editing.baseEtag));
      toast.success(`Saved ${body.title}`);
      await qc.invalidateQueries({ queryKey: QUERY_KEY });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) say((err.body as { errors?: string[] }).errors ?? [describeError(err)]);
      // The route answers a PUT for an id the library no longer has (renamed or removed on disk) with 404, before it
      // compares the ETag: that is a change on disk too.
      else if (err instanceof ApiError && (err.status === 409 || (err.status === 404 && editing.id !== null && !asNew))) await rebase();
      else {
        const issues = err instanceof ApiError && err.status === 400 ? describeIssues((err.body as { issues?: Parameters<typeof describeIssues>[0] }).issues) : [];
        say(issues.length ? issues : [`Could not save: ${describeError(err)}`]);
      }
    } finally {
      setSaving(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save(false);
  };

  const rebase = async () => {
    let fresh: ProjectsRead;
    try {
      fresh = await apiGet<ProjectsRead>('/api/projects');
    } catch (err) {
      patch((e) => ({ ...e, onDisk: null, messages: [`article-digest.md changed on disk and reloading it failed: ${describeError(err)}. Your draft is kept. Try again.`] }));
      return;
    }
    // The form's state first, then the list: the list refresh can move the form, and its state lives in the parent.
    patch((e) => rebaseOn(e, fresh));
    qc.setQueryData(QUERY_KEY, fresh);
  };

  return (
    <form className="project-form" aria-label={label} onSubmit={submit} noValidate>
      <h3 className="project-form__title">{editing.id === null ? 'New project' : `Editing ${editing.draft.title || 'project'}`}</h3>
      <div className="project-form__grid">
        <label className="project-field project-field--wide">
          <span className="project-field__label">Title</span>
          <input aria-label="Title" value={draft.title} onChange={(e) => set({ title: e.target.value })} placeholder="Ticket Triage Bot" />
        </label>
        <label className="project-field project-field--wide">
          <span className="project-field__label">Link</span>
          <input aria-label="Link" value={draft.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://github.com/you/project" inputMode="url" />
        </label>
        <label className="project-field">
          <span className="project-field__label">Tags</span>
          <input aria-label="Tags" value={draft.tags} onChange={(e) => set({ tags: e.target.value })} placeholder="python, fastapi, rag" />
        </label>
        <label className="project-field">
          <span className="project-field__label">Kind</span>
          <select aria-label="Kind" value={draft.kind} onChange={(e) => set({ kind: e.target.value as ProjectDraft['kind'] })}>
            {KIND_OPTIONS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label className="project-field">
          <span className="project-field__label">Dates</span>
          <input aria-label="Dates" value={draft.dates} onChange={(e) => set({ dates: e.target.value })} placeholder="2024-01 - 2024-05" />
        </label>
      </div>
      <fieldset className="project-bullets">
        <legend className="project-field__label">Bullets</legend>
        <ol className="project-bullets__list">
          {draft.bullets.map((b, i) => (
            <li key={i} className="bullet-row">
              <span className="bullet-row__num mono" aria-hidden="true">
                {i + 1}
              </span>
              <textarea aria-label={`Bullet ${i + 1}`} rows={2} value={b} onChange={(e) => setBullet(i, e.target.value)} />
              <span className="bullet-row__tools">
                <button type="button" className="button--ghost icon-button" aria-label={`Move bullet ${i + 1} up`} disabled={i === 0} onClick={() => set({ bullets: moveItem(draft.bullets, i, i - 1) })}>
                  <ArrowUp size={16} aria-hidden="true" />
                </button>
                <button type="button" className="button--ghost icon-button" aria-label={`Move bullet ${i + 1} down`} disabled={i === draft.bullets.length - 1} onClick={() => set({ bullets: moveItem(draft.bullets, i, i + 1) })}>
                  <ArrowDown size={16} aria-hidden="true" />
                </button>
                <button type="button" className="button--ghost icon-button" aria-label={`Remove bullet ${i + 1}`} disabled={draft.bullets.length === 1} onClick={() => set({ bullets: draft.bullets.filter((_, j) => j !== i) })}>
                  <X size={16} aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ol>
        <button type="button" disabled={draft.bullets.length >= 8} onClick={() => set({ bullets: [...draft.bullets, ''] })}>
          <Plus size={16} aria-hidden="true" /> Add bullet
        </button>
      </fieldset>
      {liveEtag !== editing.baseEtag && messages.length === 0 && (
        <ul className="form-errors" role="alert">
          <li>article-digest.md changed on disk since you opened this form. Your draft is kept; Save project shows the conflict before anything is written.</li>
        </ul>
      )}
      {messages.length > 0 && (
        <ul className="form-errors" role="alert">
          {messages.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      {editing.orphaned && (
        <details open className="project-ondisk">
          <summary>Entries on disk now</summary>
          <ul aria-label="Entries on disk now">
            {onDiskTitles.length ? onDiskTitles.map((t) => <li key={t}>{t}</li>) : <li className="faint">none</li>}
          </ul>
        </details>
      )}
      {onDisk && (
        <details open className="project-ondisk">
          <summary>Version on disk</summary>
          <dl className="kv" aria-label="Version on disk">
            {onDisk.fields.map((f) => (
              <div key={f} className="kv__pair">
                <dt>{fieldLabel(f)}</dt>
                <dd>{f === 'bullets' ? <ol>{onDisk.entry.bullets.map((b, i) => <li key={i}>{b}</li>)}</ol> : String(onDisk.entry[f] || 'none')}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      <div className="row gap project-form__actions">
        <button type="submit" className="button--primary" disabled={saving || editing.orphaned}>
          Save project
        </button>
        {editing.orphaned && (
          <button type="button" disabled={saving} onClick={() => void save(true)}>
            Save as new project
          </button>
        )}
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ProjectsImport({ etag, onAppended }: { etag: string | null; onAppended: () => void }) {
  const [format, setFormat] = useState<'json' | 'markdown'>('json');
  const [text, setText] = useState('');
  // A preview remembers the source it was made for, so Append never pairs it with a newer one.
  const [previewed, setPreviewed] = useState<{ result: ConvertResult; source: string | null } | null>(null);
  const preview = previewed?.result ?? null;
  const [error, setError] = useState<string | null>(null);
  const [uploadPath, setUploadPath] = useState<string | null>(null);
  // The documents/ source the draft came from (intake's path, e.g. projects/x.pdf); sent with preview and append.
  const [source, setSource] = useState<string | null>(null);
  // The upload whose parser may fill the draft; a retired session's late envelope is dropped.
  const currentUpload = useRef<string | null>(null);
  // Bumped by every change to the draft (file choice, parser fill); an async step that finishes under an older generation is dropped.
  const generation = useRef(0);
  const showUpload = (p: string | null) => {
    currentUpload.current = p;
    setUploadPath(p);
  };
  const envelopeFor = useCallback(
    (forPath: string) => (kind: string, payload: unknown) => {
      if (kind !== 'projects' || currentUpload.current !== forPath) return;
      generation.current += 1;
      setSource(forPath);
      setFormat('markdown');
      setText((payload as { markdown: string }).markdown);
      setPreviewed(null);
    },
    [],
  );
  const onUploadEnvelope = useMemo(() => (uploadPath ? envelopeFor(uploadPath) : undefined), [uploadPath, envelopeFor]);

  const onFile = async (file: File) => {
    const mine = ++generation.current;
    const current = () => generation.current === mine;
    setError(null);
    setPreviewed(null);
    setSource(null);
    showUpload(null);
    if (/\.(json|md|markdown|txt)$/i.test(file.name)) {
      const content = await file.text();
      if (!current()) return;
      setFormat(/\.json$/i.test(file.name) ? 'json' : 'markdown');
      setText(content);
      return;
    }
    // A PDF is kept under documents/projects/ as an intake source; the server refuses what intake cannot read.
    const type = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : 'application/octet-stream');
    const res = await fetch(`/api/projects/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': type, 'X-CC': '1' }, body: file });
    const body = (await res.json().catch(() => null)) as { error?: string; path?: string } | null;
    if (!current()) return;
    if (!res.ok || !body?.path) {
      setError(body?.error ?? `Upload failed (${res.status}). JSON, Markdown or PDF only.`);
      return;
    }
    showUpload(body.path);
  };

  // A manual edit or format change makes the draft the user's own: it no longer restates the document, so provenance goes.
  const editDraft = (patch: { text?: string; format?: 'json' | 'markdown' }) => {
    generation.current += 1;
    if (patch.text !== undefined) setText(patch.text);
    if (patch.format !== undefined) setFormat(patch.format);
    setSource(null);
    setPreviewed(null);
  };

  const convert = async () => {
    const mine = generation.current;
    const forSource = source;
    setError(null);
    try {
      const result = await apiSend<ConvertResult>('POST', '/api/projects/convert', { format, text, ...(forSource ? { source: forSource } : {}) });
      if (generation.current === mine) setPreviewed({ result, source: forSource });
    } catch (err) {
      if (generation.current !== mine) return;
      setPreviewed(null);
      setError(describeError(err));
    }
  };

  const append = async () => {
    if (!previewed?.result.markdown) return;
    const { result, source: forSource } = previewed;
    const mine = generation.current;
    try {
      const out = await apiSend<{ recorded?: boolean; warning?: string }>('POST', '/api/projects/append', { markdown: result.markdown, ...(forSource ? { source: forSource } : {}) }, ifMatch(etag));
      toast.success(out.recorded ? `Imported into article-digest.md; documents/${forSource} is recorded as ingested` : 'Imported into article-digest.md');
      if (out.warning) toast.warning(out.warning);
      onAppended();
      if (generation.current !== mine) return;
      generation.current += 1;
      setPreviewed(null);
      setText('');
      setSource(null);
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { errors?: string[] }) : null;
      setError(body?.errors?.join(' ') ?? describeError(err));
    }
  };

  const fresh = preview ? preview.entries.length - preview.duplicates.length : 0;
  return (
    <div className="card projects-card">
      <h2>Import projects</h2>
      <p className="muted small">Paste a projects JSON (AutoJobApply or JSON Resume) or library markdown, or pick a file. A PDF is kept in documents/projects/; the app extracts its text as intake does and a read-only parser session proposes blocks from it (uses tokens). Nothing is written to the library until you append.</p>
      <div className="row gap projects-import__controls">
        <label className="project-field project-field--inline">
          <span className="project-field__label">Format</span>
          <select aria-label="Import format" value={format} onChange={(e) => editDraft({ format: e.target.value as 'json' | 'markdown' })}>
            <option value="json">Projects JSON</option>
            <option value="markdown">Library markdown</option>
          </select>
        </label>
        <FilePicker label="Projects file" accept=".json,.md,.markdown,.txt,.pdf" onFile={(f) => void onFile(f)} />
      </div>
      {uploadPath && (
        <SessionPanel
          key={uploadPath}
          mode="projects-ingest"
          title="Parse the uploaded document"
          target={{ type: 'text', value: uploadPath }}
          initialPrompt={`Extract the projects from documents/${uploadPath} (the app attaches its text) and emit them in the projects envelope.`}
          autoStart
          onEnvelope={onUploadEnvelope}
          startLabel="Parse"
        />
      )}
      {source && (
        <p className="row gap small projects-source" aria-label="Import source">
          <Pill tone="info">Source: documents/{source}</Pill>
          <span className="muted">Each block gets a Source line; Append records the document as ingested, as intake does. Editing the text drops the source.</span>
        </p>
      )}
      <textarea aria-label="Projects to import" className="mono projects-import__text" rows={8} value={text} onChange={(e) => editDraft({ text: e.target.value })} placeholder={format === 'json' ? '[{"name": "...", "description": "...", "highlights": []}]' : '## Project -- https://...\n- What you built.'} />
      <div className="row gap">
        <button type="button" disabled={!text.trim()} onClick={() => void convert()}>
          Preview
        </button>
        {preview && (
          <button type="button" className="button--primary" disabled={!preview.markdown || preview.errors.length > 0} onClick={() => void append()}>
            Append {plural(fresh, 'project')}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="danger-text">
          {error}
        </p>
      )}
      {preview && (
        <div className="projects-preview" aria-label="Import preview">
          <div className="row gap">
            <Pill tone={fresh && preview.errors.length === 0 ? 'ok' : 'neutral'}>{fresh} new</Pill>
            {preview.duplicates.length > 0 && <Pill tone="warn">{preview.duplicates.length} already in the library</Pill>}
          </div>
          {preview.errors.length > 0 && (
            <ul className="form-errors small" role="alert" aria-label="Import errors">
              {preview.errors.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
          {preview.warnings.length + preview.duplicates.length > 0 && (
            <ul className="projects-preview__notes small">
              {preview.warnings.map((m) => (
                <li key={m}>{m}</li>
              ))}
              {preview.duplicates.map((d) => (
                <li key={d} className="muted">
                  Skipped &quot;{d}&quot;: already in the library
                </li>
              ))}
            </ul>
          )}
          {preview.markdown && (
            <pre tabIndex={0} className="mono small projects-preview__md">
              {preview.markdown}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function RankPreview() {
  const [jd, setJd] = useState('');
  const [result, setResult] = useState<RankResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rank = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await apiSend<{ result: RankResult }>('POST', '/api/actions/projects.rank', { params: { text: jd } });
      setResult(out.result);
    } catch (err) {
      setResult(null);
      const body = err instanceof ApiError ? (err.body as { stderr?: string }) : null;
      setError(body?.stderr?.trim().split('\n').at(-1) ?? describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const recommended = result ? result.recommended.map((id) => result.candidates.find((c) => c.id === id)!).filter(Boolean) : [];
  const rest = result ? result.candidates.filter((c) => !result.recommended.includes(c.id) && c.score > 0) : [];
  const noOverlap = result ? result.candidates.filter((c) => c.score === 0) : [];
  const coverage = result ? Object.entries(result.libraryCoverage) : [];
  return (
    <div className="card projects-card">
      <h2>Rank against a job description</h2>
      <p className="muted small">Deterministic, no tokens: the same ranking a tailored CV starts from (custom/projects/rank.mjs).</p>
      <textarea aria-label="Job description" rows={6} value={jd} onChange={(e) => setJd(e.target.value)} placeholder="Paste the job description" />
      <div className="row gap">
        <button type="button" className="button--primary" disabled={!jd.trim() || busy} onClick={() => void rank()}>
          Rank projects
        </button>
      </div>
      {error && (
        <p role="alert" className="danger-text">
          {error}
        </p>
      )}
      {result && (
        <div className="rank-result" aria-label="Ranking">
          <h3>Recommended</h3>
          {recommended.length === 0 ? (
            <Empty>No project matches this job description.</Empty>
          ) : (
            <ol className="rank-list">
              {recommended.map((c) => (
                <li key={c.id} className="rank-item">
                  <div className="rank-item__head">
                    <span className="rank-item__title">{c.title}</span>
                    <Pill tone="accent">score {c.score}</Pill>
                    {c.inCv && <Pill tone="ok">In CV</Pill>}
                  </div>
                  {c.matchedSkills.length > 0 && (
                    <div className="project-row__tags">
                      {c.matchedSkills.map((s) => (
                        <span key={s} className="project-tag mono">
                          {s}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
          {rest.length > 0 && (
            <>
              <h3>Other candidates</h3>
              <ul className="rank-others small">
                {rest.map((c) => (
                  <li key={c.id}>
                    <span>{c.title}</span> <span className="faint">score {c.score}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {noOverlap.length > 0 && <p className="muted small">No overlap with this job description: {noOverlap.map((c) => c.title).join(', ')}</p>}
          {result.excluded.length > 0 && <p className="muted small">Not ranked (not projects): {result.excluded.map((e) => `${e.title} (${e.kind})`).join(', ')}</p>}
          {coverage.length > 0 && (
            <p className="muted small">Skills missing from cv.md but shown by a library project: {coverage.map(([skill, ids]) => `${skill} (${ids.map((id) => result.candidates.find((c) => c.id === id)?.title ?? id).join(', ')})`).join('; ')}</p>
          )}
        </div>
      )}
    </div>
  );
}

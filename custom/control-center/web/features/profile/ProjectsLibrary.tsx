// Profile > Projects: the projects library (article-digest.md) as a list with
// badges, a one-entry form, validation, import (paste, file, or a read-only
// parser session for PDF/DOCX) and a rank preview against a pasted JD.
import { useCallback, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { apiGet, apiSend, ApiError } from '../../lib/api';
import { describeError } from '../../lib/actions';
import { useConfirm } from '../../components/ConfirmDialog';
import { SessionPanel } from '../../components/SessionPanel';
import { DataState, Empty, Pill } from '../../components/ui';
import type { ConvertResult, ProjectView, ProjectsRead, RankResult } from '@shared/api';
import { KIND_OPTIONS, draftFromEntry, draftProblems, emptyDraft, entryFromDraft, hostOf, moveItem, type ProjectDraft } from './projectsDraft';

const QUERY_KEY = ['config', 'projects'];
const useProjects = () => useQuery({ queryKey: QUERY_KEY, queryFn: () => apiGet<ProjectsRead>('/api/projects') });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ifMatch = (etag: string | null | undefined): Record<string, string> => (etag ? { 'If-Match': etag } : {});

interface Editing {
  id: string | null;
  draft: ProjectDraft;
  tagline: string | null;
}

export function ProjectsLibrary() {
  const q = useProjects();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Editing | null>(null);
  const data = q.data;
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
          <button type="button" className="button--primary" disabled={!data || editing !== null} title={editing ? 'Save or cancel the open form first' : undefined} onClick={() => setEditing({ id: null, draft: emptyDraft(), tagline: null })}>
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
        <DataState query={q}>
          {data && <ValidationPanel validation={data.validation} />}
          {editing?.id === null && <ProjectForm editing={editing} etag={data?.etag ?? null} onChange={setEditing} onDone={() => setEditing(null)} />}
          {data && data.entries.length === 0 && editing === null && (
            <Empty>{data.kind === 'missing' ? 'No article-digest.md yet. Add a project or import a list below; the file is created on the first save.' : 'The library has no entries yet.'}</Empty>
          )}
          {data && data.entries.length > 0 && (
            <ul className="project-list" aria-label="Projects in the library">
              {data.entries.map((entry) =>
                editing?.id === entry.id ? (
                  <li key={entry.id} className="project-row project-row--editing">
                    <ProjectForm editing={editing} etag={data.etag} onChange={setEditing} onDone={() => setEditing(null)} />
                  </li>
                ) : (
                  <ProjectRow key={entry.id} entry={entry} disabled={editing !== null} onEdit={() => setEditing({ id: entry.id, draft: draftFromEntry(entry), tagline: entry.tagline })} onDelete={() => void remove(entry)} />
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
      </div>
      <div className="project-row__actions">
        <button type="button" aria-label={`Edit ${entry.title}`} disabled={disabled} onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="button--ghost" aria-label={`Delete ${entry.title}`} disabled={disabled} onClick={onDelete}>
          Delete
        </button>
      </div>
    </li>
  );
}

function ProjectForm({ editing, etag, onChange, onDone }: { editing: Editing; etag: string | null; onChange: (e: Editing) => void; onDone: () => void }) {
  const qc = useQueryClient();
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const { draft } = editing;
  const set = (patch: Partial<ProjectDraft>) => onChange({ ...editing, draft: { ...draft, ...patch } });
  const setBullet = (i: number, value: string) => set({ bullets: draft.bullets.map((b, j) => (j === i ? value : b)) });
  const label = editing.id === null ? 'Add a project' : `Edit ${draft.title || 'project'}`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problems = draftProblems(draft);
    setErrors(problems);
    if (problems.length) return;
    setSaving(true);
    try {
      const body = entryFromDraft(draft, editing.tagline);
      if (editing.id === null) await apiSend('POST', '/api/projects', body, ifMatch(etag));
      else await apiSend('PUT', `/api/projects/${editing.id}`, body, ifMatch(etag));
      toast.success(`Saved ${body.title}`);
      await qc.invalidateQueries({ queryKey: QUERY_KEY });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) setErrors((err.body as { errors?: string[] }).errors ?? [describeError(err)]);
      else if (err instanceof ApiError && err.status === 409) {
        setErrors(['article-digest.md changed on disk since it was loaded. The list is refreshed; your draft is kept, so save again to apply it.']);
        await qc.invalidateQueries({ queryKey: QUERY_KEY });
      } else setErrors([`Could not save: ${describeError(err)}`]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="project-form" aria-label={label} onSubmit={(e) => void submit(e)} noValidate>
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
      {errors.length > 0 && (
        <ul className="form-errors" role="alert">
          {errors.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      <div className="row gap project-form__actions">
        <button type="submit" className="button--primary" disabled={saving}>
          Save project
        </button>
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
  const [preview, setPreview] = useState<ConvertResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadPath, setUploadPath] = useState<string | null>(null);
  // The upload whose parser may fill the draft; a retired session's late envelope is dropped.
  const currentUpload = useRef<string | null>(null);
  const showUpload = (p: string | null) => {
    currentUpload.current = p;
    setUploadPath(p);
  };
  const envelopeFor = useCallback(
    (forPath: string) => (kind: string, payload: unknown) => {
      if (kind !== 'projects' || currentUpload.current !== forPath) return;
      setFormat('markdown');
      setText((payload as { markdown: string }).markdown);
      setPreview(null);
    },
    [],
  );
  const onUploadEnvelope = useMemo(() => (uploadPath ? envelopeFor(uploadPath) : undefined), [uploadPath, envelopeFor]);

  const onFile = async (file: File) => {
    setError(null);
    setPreview(null);
    showUpload(null);
    if (/\.json$/i.test(file.name)) {
      setFormat('json');
      setText(await file.text());
      return;
    }
    if (/\.(md|markdown|txt)$/i.test(file.name)) {
      setFormat('markdown');
      setText(await file.text());
      return;
    }
    const type = file.type || (file.name.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const res = await fetch(`/api/cv/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': type, 'X-CC': '1' }, body: file });
    if (!res.ok) {
      setError(`Upload failed (${res.status}). JSON, Markdown, PDF or DOCX only.`);
      return;
    }
    showUpload(((await res.json()) as { path: string }).path);
  };

  const convert = async () => {
    setError(null);
    try {
      setPreview(await apiSend<ConvertResult>('POST', '/api/projects/convert', { format, text }));
    } catch (err) {
      setPreview(null);
      setError(describeError(err));
    }
  };

  const append = async () => {
    if (!preview?.markdown) return;
    try {
      await apiSend('POST', '/api/projects/append', { markdown: preview.markdown }, ifMatch(etag));
      toast.success('Imported into article-digest.md');
      setPreview(null);
      setText('');
      onAppended();
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { errors?: string[] }) : null;
      setError(body?.errors?.join(' ') ?? describeError(err));
    }
  };

  const fresh = preview ? preview.entries.length - preview.duplicates.length : 0;
  return (
    <div className="card projects-card">
      <h2>Import projects</h2>
      <p className="muted small">Paste a projects JSON (AutoJobApply or JSON Resume) or library markdown, or pick a file. A PDF or DOCX goes to a read-only parser session (uses tokens). Nothing is written until you append.</p>
      <div className="row gap projects-import__controls">
        <label className="project-field project-field--inline">
          <span className="project-field__label">Format</span>
          <select aria-label="Import format" value={format} onChange={(e) => setFormat(e.target.value as 'json' | 'markdown')}>
            <option value="json">Projects JSON</option>
            <option value="markdown">Library markdown</option>
          </select>
        </label>
        <input type="file" aria-label="Projects file" accept=".json,.md,.markdown,.txt,.pdf,.docx" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
      </div>
      {uploadPath && (
        <SessionPanel
          key={uploadPath}
          mode="projects-ingest"
          title="Parse the uploaded document"
          target={{ type: 'text', value: uploadPath }}
          initialPrompt={`Read the document at ${uploadPath} and emit its projects in the projects envelope.`}
          autoStart
          onEnvelope={onUploadEnvelope}
          startLabel="Parse"
        />
      )}
      <textarea aria-label="Projects to import" className="mono editor" rows={8} value={text} onChange={(e) => (setText(e.target.value), setPreview(null))} placeholder={format === 'json' ? '[{"name": "...", "description": "...", "highlights": []}]' : '## Project -- https://...\n- What you built.'} />
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
            <Pill tone={fresh ? 'ok' : 'neutral'}>{fresh} new</Pill>
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

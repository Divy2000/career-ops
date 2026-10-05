import { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend, ApiError } from '../../lib/api';
import { SessionPanel } from '../../components/SessionPanel';
import { ModeLauncher } from '../../components/ModeLauncher';
import { DataState, FilePicker, Pill, Tabs } from '../../components/ui';
import { useEditBase } from '../../lib/editBase';
import { ProjectsLibrary } from './ProjectsLibrary';

interface UserFile {
  key: string;
  path: string;
  kind: 'ok' | 'missing';
  text: string;
  etag: string | null;
}

/** Raw editors under "More files"; cv.md has its own tab and article-digest.md its Projects tab (raw text here too). */
const USER_FILE_KEYS: Array<{ key: string; label: string }> = [
  { key: 'articleDigest', label: 'article-digest.md' },
  { key: 'profileMd', label: 'modes/_profile.md' },
  { key: 'briefMd', label: 'modes/_brief.md' },
  { key: 'voiceDna', label: 'voice-dna.md' },
  { key: 'storyBank', label: 'interview-prep/story-bank.md' },
];

const AI_FLOWS = [
  { id: 'interview', label: 'Onboarding interview', prompt: 'Run the onboarding interview to build my profile.' },
  { id: 'master-profile', label: 'Master profile', prompt: 'Rebuild the master profile from my CV and notes.' },
  { id: 'add', label: 'Add an entry', prompt: 'Add this to my profile: ' },
  { id: 'expand', label: 'Expand a section', prompt: 'Expand this CV section with concrete outcomes: ' },
  { id: 'intake', label: 'Intake', prompt: 'Run the intake flow.' },
  { id: 'research', label: 'Portfolio research', prompt: 'Research how my portfolio reads to a hiring manager.' },
  { id: 'training', label: 'Evaluate a course', prompt: 'Evaluate this course for my goals: ' },
  { id: 'project', label: 'Evaluate a project', prompt: 'Evaluate this project idea for my goals: ' },
];

function useUserFile(key: string) {
  return useQuery({ queryKey: ['config', 'user-file', key], queryFn: () => apiGet<UserFile>(`/api/files/user/${key}`) });
}

/**
 * Plain textarea editor with ETag save. It saves against the version the draft was made on, so a change on disk
 * mid-edit (the watcher refetches the file) is announced and refused with 409, never overwritten; the 409 shows the
 * current server text for a manual merge, and saving again after it overwrites deliberately.
 */
export function UserFileEditor({ fileKey, label }: { fileKey: string; label: string }) {
  const q = useUserFile(fileKey);
  const qc = useQueryClient();
  const edit = useEditBase(q.data);
  // Edits live in local state; until the first keystroke the server text is shown as is.
  const [draft, setDraft] = useState<string | null>(null);
  // The draft as last typed, read after a save's refetch (refs are only touched in handlers).
  const latestDraft = useRef<string | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [conflict, setConflict] = useState<UserFile | null>(null);
  const text = draft ?? q.data?.text ?? '';
  const onEdit = (value: string) => {
    edit.pin();
    latestDraft.current = value;
    setDraft(value);
  };
  const save = async () => {
    setNote(null);
    const from = edit.base ?? q.data;
    const etag = from?.etag ?? null;
    try {
      const r = await apiSend<{ etag: string }>('PUT', `/api/files/user/${fileKey}`, { text }, etag ? { 'If-Match': etag } : {});
      // The saved text is the new base, so the refetch of this very write is not a change on disk.
      if (from) edit.rebase({ ...from, kind: 'ok', text, etag: r.etag });
      setConflict(null);
      setNote({ tone: 'ok', text: `Saved ${label}` });
      await qc.invalidateQueries({ queryKey: ['config'] });
      // Nothing typed since: show the file as the server has it again, so later changes on disk appear here.
      if (latestDraft.current === text) {
        latestDraft.current = null;
        setDraft(null);
        edit.rebase(null);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const current = (err.body as { current: UserFile }).current;
        setConflict(current);
        edit.rebase(current);
        setNote({ tone: 'danger', text: 'The file changed on disk since you loaded it. Review the current version below, then save again to overwrite it.' });
      } else setNote({ tone: 'danger', text: `Could not save: ${(err as Error).message}` });
    }
  };
  return (
    <div className="card">
      <div className="row gap" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>
          {label} {q.data?.kind === 'missing' && <Pill tone="warn">not created yet</Pill>}
        </h2>
        <button type="button" onClick={() => void save()} disabled={!q.data || text === q.data.text}>
          Save
        </button>
      </div>
      <DataState query={q}>
        <textarea aria-label={`${label} contents`} className="mono editor" rows={14} value={text} onChange={(e) => onEdit(e.target.value)} />
      </DataState>
      {edit.drifted && (
        <p role="alert" className="danger-text">
          {label} changed on disk since you started editing. Your edits are kept here; Save shows the current version so you can merge them.
        </p>
      )}
      {note && (
        <p role={note.tone === 'danger' ? 'alert' : 'status'} className={note.tone === 'danger' ? 'danger-text' : 'muted'}>
          {note.text}
        </p>
      )}
      {conflict && (
        <details open>
          <summary>Current version on disk</summary>
          <pre tabIndex={0} className="log mono small">{conflict.text}</pre>
        </details>
      )}
    </div>
  );
}

export function CvImport({ onImported }: { onImported?: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [uploadPath, setUploadPath] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The upload whose parser may fill the draft; a retired session's late envelope is dropped.
  const currentUpload = useRef<string | null>(null);
  const showUpload = (p: string | null) => {
    currentUpload.current = p;
    setUploadPath(p);
  };
  const envelopeFor = useCallback(
    (forPath: string) => (kind: string, payload: unknown) => {
      if (kind === 'cv' && currentUpload.current === forPath) setDraft((payload as { markdown: string }).markdown);
    },
    [],
  );
  const onEnvelope = useMemo(() => (uploadPath ? envelopeFor(uploadPath) : undefined), [uploadPath, envelopeFor]);
  // Bumped by every file pick; an upload or read that finishes under an older pick is dropped (as the projects import does).
  const generation = useRef(0);
  const onFile = async (file: File) => {
    const mine = ++generation.current;
    const current = () => generation.current === mine;
    setNote(null);
    showUpload(null);
    if (/\.(md|txt|markdown)$/i.test(file.name)) {
      const text = await file.text();
      if (current()) setDraft(text);
      return;
    }
    const type = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : 'application/octet-stream');
    const res = await fetch(`/api/cv/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': type, 'X-CC': '1' }, body: file });
    const body = (await res.json().catch(() => null)) as { error?: string; path?: string } | null;
    if (!current()) return;
    if (!res.ok || !body?.path) {
      setNote(`Upload failed (${res.status}): ${body?.error ?? 'PDF only'}.`);
      return;
    }
    showUpload(body.path);
  };
  const save = async () => {
    const current = await apiGet<UserFile>('/api/files/user/cv');
    await apiSend('PUT', '/api/files/user/cv', { text: draft }, current.etag ? { 'If-Match': current.etag } : {});
    setNote('cv.md saved. Run a network scan from Discover to find matches.');
    await qc.invalidateQueries({ queryKey: ['config'] });
    onImported?.();
  };
  return (
    <div className="card import-card">
      <h2>Import CV</h2>
      <p className="muted">Paste the text, drop a .md or .txt file, or upload a PDF for the parser session (uses tokens, read-only scope).</p>
      <div className="row gap import-card__controls">
        <FilePicker label="CV file" accept=".md,.txt,.markdown,.pdf" onFile={(f) => void onFile(f)} />
      </div>
      {uploadPath && <SessionPanel key={uploadPath} mode="cv-ingest" title="Parse the uploaded CV" target={{ type: 'text', value: uploadPath }} initialPrompt={`Read the CV at ${uploadPath} and emit it as markdown in the cv envelope.`} autoStart onEnvelope={onEnvelope} startLabel="Parse" />}
      <textarea aria-label="CV markdown" className="mono editor" rows={12} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="# Your name ..." />
      <div className="row gap">
        <button type="button" disabled={!draft.trim()} onClick={() => void save()}>
          Save as cv.md
        </button>
        {note && (
          <span role="status" className="muted small">
            {note}
          </span>
        )}
      </div>
    </div>
  );
}

type ProfileTab = 'cv' | 'projects' | 'files';
const PROFILE_TABS: Array<{ id: ProfileTab; label: string }> = [
  { id: 'cv', label: 'CV' },
  { id: 'projects', label: 'Projects' },
  { id: 'files', label: 'More files' },
];

export function ProfilePage() {
  const [tab, setTab] = useState<ProfileTab>('cv');
  const [file, setFile] = useState(USER_FILE_KEYS[0]!.key);
  const chosen = USER_FILE_KEYS.find((f) => f.key === file) ?? USER_FILE_KEYS[0]!;
  return (
    <section aria-labelledby="page-title">
      <div className="page-header">
        <h1 id="page-title">Profile & CV</h1>
      </div>
      <Tabs tabs={PROFILE_TABS} value={tab} onChange={setTab} label="Profile sections" />
      <div className="split">
        <div className="stack">
          {tab === 'cv' && (
            <>
              <UserFileEditor key="cv" fileKey="cv" label="cv.md" />
              <CvImport />
            </>
          )}
          {tab === 'projects' && <ProjectsLibrary />}
          {tab === 'files' && (
            <>
              <label className="row gap">
                File
                <select aria-label="User file" value={file} onChange={(e) => setFile(e.target.value)}>
                  {USER_FILE_KEYS.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
              <UserFileEditor key={chosen.key} fileKey={chosen.key} label={chosen.label} />
            </>
          )}
        </div>
        <div className="stack">
          <ModeLauncher heading="AI flows" modes={AI_FLOWS} />
          <ModeLauncher heading="Exports" modes={[{ id: 'text', label: 'Plain text CV', prompt: 'Export my CV as plain text.' }, { id: 'latex', label: 'LaTeX CV', prompt: 'Export my CV to LaTeX.' }, { id: 'latex-tex', label: 'LaTeX from .tex source', prompt: 'Rebuild the PDF from my .tex source.' }]} />
        </div>
      </div>
    </section>
  );
}

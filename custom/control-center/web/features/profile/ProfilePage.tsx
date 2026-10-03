import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend, ApiError } from '../../lib/api';
import { SessionPanel } from '../../components/SessionPanel';
import { ModeLauncher } from '../../components/ModeLauncher';
import { DataState, Pill } from '../../components/ui';

interface UserFile {
  key: string;
  path: string;
  kind: 'ok' | 'missing';
  text: string;
  etag: string | null;
}

const USER_FILE_KEYS: Array<{ key: string; label: string }> = [
  { key: 'cv', label: 'cv.md' },
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

/** Plain textarea editor with ETag save; a 409 shows the current server text for a manual merge. */
export function UserFileEditor({ fileKey, label }: { fileKey: string; label: string }) {
  const q = useUserFile(fileKey);
  const qc = useQueryClient();
  // Edits live in local state; until the first keystroke the server text is shown as is.
  const [draft, setDraft] = useState<string | null>(null);
  const [savedEtag, setSavedEtag] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [conflict, setConflict] = useState<UserFile | null>(null);
  const text = draft ?? q.data?.text ?? '';
  const etag = savedEtag ?? q.data?.etag ?? null;
  const setText = setDraft;
  const setEtag = setSavedEtag;
  const save = async () => {
    setNote(null);
    try {
      const r = await apiSend<{ etag: string }>('PUT', `/api/files/user/${fileKey}`, { text }, etag ? { 'If-Match': etag } : {});
      setEtag(r.etag);
      setConflict(null);
      setNote({ tone: 'ok', text: `Saved ${label}` });
      await qc.invalidateQueries({ queryKey: ['config'] });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflict((err.body as { current: UserFile }).current);
        setNote({ tone: 'danger', text: 'The file changed on disk since you loaded it. Review the current version below, then save again to overwrite it.' });
        setEtag((err.body as { current: UserFile }).current.etag);
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
        <textarea aria-label={`${label} contents`} className="mono editor" rows={14} value={text} onChange={(e) => setText(e.target.value)} />
      </DataState>
      {note && (
        <p role={note.tone === 'danger' ? 'alert' : 'status'} className={note.tone === 'danger' ? 'danger-text' : 'muted'}>
          {note.text}
        </p>
      )}
      {conflict && (
        <details open>
          <summary>Current version on disk</summary>
          <pre className="log mono small">{conflict.text}</pre>
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
  const onEnvelope = useCallback((kind: string, payload: unknown) => {
    if (kind === 'cv') setDraft((payload as { markdown: string }).markdown);
  }, []);
  const onFile = async (file: File) => {
    setNote(null);
    if (/\.(md|txt|markdown)$/i.test(file.name)) {
      setDraft(await file.text());
      return;
    }
    const type = file.type || (file.name.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const res = await fetch(`/api/cv/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': type, 'X-CC': '1' }, body: file });
    if (!res.ok) {
      setNote(`Upload failed (${res.status}). PDF and DOCX only.`);
      return;
    }
    setUploadPath(((await res.json()) as { path: string }).path);
  };
  const save = async () => {
    const current = await apiGet<UserFile>('/api/files/user/cv');
    await apiSend('PUT', '/api/files/user/cv', { text: draft }, current.etag ? { 'If-Match': current.etag } : {});
    setNote('cv.md saved. Run a network scan from Discover to find matches.');
    await qc.invalidateQueries({ queryKey: ['config'] });
    onImported?.();
  };
  return (
    <div className="card">
      <h2>Import CV</h2>
      <p className="muted">Paste the text, drop a .md or .txt file, or upload a PDF or DOCX for the parser session (uses tokens, read-only scope).</p>
      <div className="row gap">
        <input type="file" aria-label="CV file" accept=".md,.txt,.markdown,.pdf,.docx" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
      </div>
      {uploadPath && <SessionPanel mode="cv-ingest" title="Parse the uploaded CV" target={{ type: 'text', value: uploadPath }} initialPrompt={`Read the CV at ${uploadPath} and emit it as markdown in the cv envelope.`} autoStart onEnvelope={onEnvelope} startLabel="Parse" />}
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

export function ProfilePage() {
  const [file, setFile] = useState('cv');
  const chosen = USER_FILE_KEYS.find((f) => f.key === file) ?? USER_FILE_KEYS[0]!;
  return (
    <section aria-labelledby="page-title">
      <div className="page-header">
        <h1 id="page-title">Profile & CV</h1>
        <label>
          File{' '}
          <select aria-label="User file" value={file} onChange={(e) => setFile(e.target.value)}>
            {USER_FILE_KEYS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="split">
        <div className="stack">
          <UserFileEditor key={chosen.key} fileKey={chosen.key} label={chosen.label} />
          <CvImport />
        </div>
        <div className="stack">
          <ModeLauncher heading="AI flows" modes={AI_FLOWS} />
          <ModeLauncher heading="Exports" modes={[{ id: 'text', label: 'Plain text CV', prompt: 'Export my CV as plain text.' }, { id: 'latex', label: 'LaTeX CV', prompt: 'Export my CV to LaTeX.' }, { id: 'latex-tex', label: 'LaTeX from .tex source', prompt: 'Rebuild the PDF from my .tex source.' }]} />
        </div>
      </div>
    </section>
  );
}

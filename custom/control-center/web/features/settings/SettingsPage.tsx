import { useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend, ApiError } from '../../lib/api';
import { useSystemStatus } from '../../lib/queries';
import { useEngine } from '../../lib/sessions';
import { useActions, useRunAction } from '../../lib/actions';
import { ActionButton, Message } from '../../components/ActionBar';
import { DataState, Empty, Pill, Tabs } from '../../components/ui';
import { UserFileEditor } from '../profile/ProfilePage';

const route = getRouteApi('/settings');
export type SettingsTab = 'portals' | 'profile' | 'rules' | 'engine' | 'health' | 'updates';
export const SYNC_PR_URL = 'https://github.com/Divy2000/career-ops/pulls?q=is%3Apr+upstream-sync+sort%3Aupdated-desc';

interface ConfigRead {
  key: string;
  path: string;
  kind: 'ok' | 'missing';
  raw: string;
  etag: string | null;
}

/** Raw YAML editor gated by the core validator; a 422 shows the findings and writes nothing. */
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
      const warnings = typeof r.warnings === 'string' ? r.warnings : JSON.stringify(r.warnings, null, 2);
      setNote({ tone: 'ok', text: `Saved ${label} (validated by ${validator}).`, details: warnings && warnings !== '""' ? warnings : undefined });
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
      <p className="muted small">Raw YAML. Comments are kept as typed. Structured per-key editors are not available yet.</p>
      <DataState query={q}>
        <textarea aria-label={`${label} YAML`} className="mono editor" rows={22} value={raw} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
      </DataState>
      {note && (
        <div role={note.tone === 'danger' ? 'alert' : 'status'} className={note.tone === 'danger' ? 'danger-text' : 'muted'}>
          {note.text}
          {note.details && <pre className="log mono small">{note.details}</pre>}
        </div>
      )}
    </div>
  );
}

function EngineTab() {
  const status = useSystemStatus();
  const engine = useEngine();
  const s = status.data;
  return (
    <div className="card">
      <h2>AI engine</h2>
      <DataState query={status}>
        {s && (
          <dl className="kv">
            <dt>Claude binary</dt>
            <dd className="mono">{s.claude.bin}</dd>
            <dt>Claude version</dt>
            <dd>{s.claude.version ?? <Pill tone="danger">{s.claude.error ?? 'not found'}</Pill>}</dd>
            <dt>Keychain token</dt>
            <dd>{s.keychainTokenPresent ? <Pill tone="ok">present</Pill> : <Pill tone="danger">missing (claude setup-token, then security add-generic-password -s career-ops-claude-token)</Pill>}</dd>
            <dt>ANTHROPIC_API_KEY in the server shell</dt>
            <dd>{s.anthropicApiKeySet ? <Pill tone="warn">set (sessions force it empty)</Pill> : <Pill tone="ok">empty</Pill>}</dd>
            <dt>Playwright MCP</dt>
            <dd>{engine.data?.playwrightAvailable ? <Pill tone="ok">probed</Pill> : <Pill tone="warn">unprobed: Apply drafts answers only</Pill>}</dd>
            <dt>Node</dt>
            <dd className="mono">{s.node}</dd>
            <dt>Roots</dt>
            <dd className="mono small">
              code {s.roots.code}
              <br />
              data {s.roots.data}
            </dd>
          </dl>
        )}
      </DataState>
      <p className="muted small">Claude is the only engine (decided). Concurrency defaults to 2 Claude slots; model defaults and usage budgets are not configurable yet.</p>
    </div>
  );
}

function HealthTab() {
  const actions = useActions();
  const { run, message, busy } = useRunAction();
  const [result, setResult] = useState<unknown>(null);
  const ids = ['system.doctor', 'tracker.verify', 'tracker.syncCheck', 'portals.validate', 'portals.verify', 'tracker.normalize', 'tracker.dedup'];
  return (
    <div className="card">
      <h2>Health</h2>
      <div className="row gap" style={{ flexWrap: 'wrap' }}>
        {ids.map((id) => (
          <ActionButton
            key={id}
            meta={actions.data?.find((a) => a.id === id)}
            disabled={busy !== null}
            params={id === 'tracker.normalize' || id === 'tracker.dedup' ? { dryRun: true } : {}}
            onRun={(p) =>
              void run(id, p).then((out) => {
                if (out && 'result' in out) setResult(out.result);
              })
            }
          />
        ))}
      </div>
      <p className="muted small">Normalize and dedup run as dry runs here; use Runs to re-run them for real.</p>
      <Message message={message} />
      {result !== null && <pre className="log mono small">{typeof result === 'string' ? result : JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
}

function UpdatesTab() {
  const actions = useActions();
  const { run, message } = useRunAction();
  const [status, setStatus] = useState<unknown>(null);
  return (
    <div className="card">
      <h2>Updates</h2>
      <p className="muted">
        This fork receives upstream changes through the weekly sync pull request, never through <span className="mono">update-system.mjs apply</span>. Status is read-only here.
      </p>
      <div className="row gap">
        <ActionButton meta={actions.data?.find((a) => a.id === 'system.updateStatus')} onRun={() => void run('system.updateStatus', {}).then((out) => out && 'result' in out && setStatus(out.result))} />
        <a className="button-link" href={SYNC_PR_URL} target="_blank" rel="noreferrer noopener">
          Latest upstream-sync PR
        </a>
      </div>
      <Message message={message} />
      {status !== null && <pre className="log mono small">{typeof status === 'string' ? status : JSON.stringify(status, null, 2)}</pre>}
    </div>
  );
}

export function SettingsPage() {
  const { tab } = route.useSearch();
  const navigate = useNavigate({ from: '/settings' });
  return (
    <section aria-labelledby="page-title">
      <div className="page-header">
        <h1 id="page-title">Settings</h1>
      </div>
      <Tabs
        label="Settings sections"
        tabs={[
          { id: 'portals', label: 'Portals' },
          { id: 'profile', label: 'Profile' },
          { id: 'rules', label: 'House rules' },
          { id: 'engine', label: 'AI engine' },
          { id: 'health', label: 'Health' },
          { id: 'updates', label: 'Updates' },
        ]}
        value={tab}
        onChange={(t: SettingsTab) => void navigate({ search: { tab: t } })}
      />
      {tab === 'portals' && <ConfigEditor fileKey="portals" label="portals.yml" validator="validate-portals.mjs" />}
      {tab === 'profile' && <ConfigEditor fileKey="profile" label="config/profile.yml" validator="validate-profile.mjs" />}
      {tab === 'rules' && <UserFileEditor fileKey="customMd" label="modes/_custom.md (house rules)" />}
      {tab === 'engine' && <EngineTab />}
      {tab === 'health' && <HealthTab />}
      {tab === 'updates' && <UpdatesTab />}
      {tab !== 'portals' && tab !== 'profile' && tab !== 'rules' && tab !== 'engine' && tab !== 'health' && tab !== 'updates' && <Empty>Unknown tab.</Empty>}
    </section>
  );
}

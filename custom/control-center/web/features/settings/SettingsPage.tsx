import { useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useSystemStatus } from '../../lib/queries';
import { useEngine } from '../../lib/sessions';
import { useActions, useRunAction } from '../../lib/actions';
import { ActionButton, Message } from '../../components/ActionBar';
import { DataState, Empty, Pill, Tabs } from '../../components/ui';
import { UserFileEditor } from '../profile/ProfilePage';
import { PortalsTab } from './PortalsEditor';
import { ProfileTab } from './ProfileForm';
import { BlacklistEditor } from './BlacklistEditor';
import { PluginsTab } from './PluginsTab';
import { AppTab, EngineSettings } from './AppTab';
import { UsageMeter } from './UsageMeter';

export { ConfigEditor } from './RawConfigEditor';

const route = getRouteApi('/settings');
export const SETTINGS_TABS = ['portals', 'profile', 'rules', 'blacklist', 'plugins', 'engine', 'health', 'updates', 'app'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
export const SYNC_PR_URL = 'https://github.com/Divy2000/career-ops/pulls?q=is%3Apr+upstream-sync+sort%3Aupdated-desc';

function EngineTab() {
  const status = useSystemStatus();
  const engine = useEngine();
  const s = status.data;
  return (
    <div className="stack">
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
        <p className="muted small">Claude is the only engine (decided). Test auth by starting any read-only session; a missing token shows up as the first event.</p>
      </div>
      <div className="card">
        <h2>Concurrency, model and budgets</h2>
        <EngineSettings />
      </div>
      <div className="card">
        <UsageMeter />
      </div>
    </div>
  );
}

function HealthTab() {
  const actions = useActions();
  const { run, message, busy } = useRunAction();
  const [result, setResult] = useState<unknown>(null);
  const ids = ['system.doctor', 'tracker.verify', 'tracker.syncCheck', 'portals.validate', 'portals.verify', 'tracker.normalize', 'tracker.dedup', 'tracker.merge', 'tracker.reconcile'];
  return (
    <div className="card">
      <h2>Health</h2>
      <div className="row gap" style={{ flexWrap: 'wrap' }}>
        {ids.map((id) => (
          <ActionButton
            key={id}
            meta={actions.data?.find((a) => a.id === id)}
            disabled={busy !== null}
            params={['tracker.normalize', 'tracker.dedup', 'tracker.merge', 'tracker.reconcile'].includes(id) ? { dryRun: true } : {}}
            onRun={(p) =>
              void run(id, p).then((out) => {
                if (out && 'result' in out) setResult(out.result);
              })
            }
          />
        ))}
      </div>
      <p className="muted small">Normalize, dedup, merge and reconcile run as dry runs here; use Runs to re-run them for real.</p>
      <Message message={message} />
      {result !== null && <pre tabIndex={0} className="log mono small">{typeof result === 'string' ? result : JSON.stringify(result, null, 2)}</pre>}
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
        <ActionButton meta={actions.data?.find((a) => a.id === 'system.updateCheck')} onRun={(p) => void run('system.updateCheck', p)} />
        <a className="button-link" href={SYNC_PR_URL} target="_blank" rel="noreferrer noopener">
          Latest upstream-sync PR
        </a>
      </div>
      <Message message={message} />
      {status !== null && <pre tabIndex={0} className="log mono small">{typeof status === 'string' ? status : JSON.stringify(status, null, 2)}</pre>}
    </div>
  );
}

export function SettingsPage() {
  const { tab, add } = route.useSearch();
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
          { id: 'blacklist', label: 'Blacklist' },
          { id: 'plugins', label: 'Plugins' },
          { id: 'engine', label: 'AI engine' },
          { id: 'health', label: 'Health' },
          { id: 'updates', label: 'Updates' },
          { id: 'app', label: 'App' },
        ]}
        value={tab}
        onChange={(t: SettingsTab) => void navigate({ search: { tab: t } })}
      />
      {tab === 'portals' && <PortalsTab />}
      {tab === 'profile' && <ProfileTab />}
      {tab === 'rules' && <UserFileEditor fileKey="customMd" label="modes/_custom.md (house rules)" />}
      {tab === 'blacklist' && <BlacklistEditor key={add ?? ''} prefillCompany={add || undefined} />}
      {tab === 'plugins' && <PluginsTab />}
      {tab === 'engine' && <EngineTab />}
      {tab === 'health' && <HealthTab />}
      {tab === 'updates' && <UpdatesTab />}
      {tab === 'app' && <AppTab />}
      {!SETTINGS_TABS.includes(tab) && <Empty>Unknown tab.</Empty>}
    </section>
  );
}

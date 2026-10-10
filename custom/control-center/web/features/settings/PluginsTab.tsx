import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiGet, apiSend } from '../../lib/api';
import { describeError, useActions, useRunAction } from '../../lib/actions';
import { ActionButton, Message } from '../../components/ActionBar';
import { Md } from '../../components/Md';
import { DataState, Empty, Pill, TableScroll } from '../../components/ui';
import type { PluginsRead } from '@shared/api';

export function PluginsTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['config', 'plugins'], queryFn: () => apiGet<PluginsRead>('/api/plugins') });
  const actions = useActions();
  const { run, message } = useRunAction();
  const [skill, setSkill] = useState<{ id: string; markdown: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One toggle at a time, until its refetch brings the new ETag: a second PUT meanwhile would carry the old one and
  // get a 409 for a file only this tab changed.
  const [toggling, setToggling] = useState(false);
  const inFlight = useRef(false);
  const toggle = async (id: string, enabled: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setToggling(true);
    setError(null);
    try {
      await apiSend('PUT', `/api/config/plugins/${id}`, { enabled }, q.data?.config.etag ? { 'If-Match': q.data.config.etag } : {});
      toast.success(`${id} ${enabled ? 'enabled' : 'disabled'} in config/plugins.yml`);
      await qc.invalidateQueries({ queryKey: ['config', 'plugins'] });
    } catch (err) {
      setError(`Could not update ${id}: ${describeError(err)}`);
    } finally {
      inFlight.current = false;
      setToggling(false);
    }
  };
  const showSkill = async (id: string) => {
    setError(null);
    try {
      setSkill(await apiGet<{ id: string; markdown: string }>(`/api/plugins/${id}/skill`));
    } catch (err) {
      setError(`Could not load the skill document: ${describeError(err)}`);
    }
  };
  return (
    <div className="stack">
      <div className="card">
        <div className="row gap" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Plugins</h2>
          <ActionButton meta={actions.data?.find((a) => a.id === 'plugins.audit')} onRun={() => void run('plugins.audit', {})} />
        </div>
        <p className="muted small">
          Plugins are off by default. Enabling one writes <span className="mono">config/plugins.yml</span> (comments kept); secrets stay in <span className="mono">.env</span>. Hooks run through <span className="mono">plugins.mjs run</span> as a tracked run.
        </p>
        <DataState query={q}>
          {q.data?.config.kind === 'malformed' && (
            <div className="card card--warn" role="alert">
              <strong>config/plugins.yml is malformed.</strong> <span className="muted">{q.data.config.error}</span>
            </div>
          )}
          {q.data && q.data.plugins.length === 0 ? (
            <Empty>No plugins found under plugins/ or plugins.local/.</Empty>
          ) : (
            <TableScroll label="Plugins">
              <table className="table" aria-label="Plugins">
                <thead>
                  <tr>
                    <th scope="col">Enabled</th>
                    <th scope="col">Plugin</th>
                    <th scope="col">Hooks</th>
                    <th scope="col">Needs</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(q.data?.plugins ?? []).map((p) => {
                    // plugins.mjs run never runs a provider hook: those ride the portal scan.
                    const hook = p.hooks.find((h) => h !== 'provider');
                    return (
                      <tr key={p.id}>
                        <td>
                          <input type="checkbox" aria-label={`Enable ${p.id}`} checked={p.enabled} disabled={toggling} onChange={(e) => void toggle(p.id, e.target.checked)} />
                        </td>
                        <td>
                          <strong>{p.name}</strong> <span className="faint mono small">{p.id} {p.version}</span>
                          <div className="muted small">{p.description}</div>
                        </td>
                        <td>
                          {p.hooks.map((h) => (
                            <Pill key={h}>{h}</Pill>
                          ))}
                        </td>
                        <td className="mono small">{p.requiredEnv.length ? p.requiredEnv.join(', ') : <span className="faint">no keys</span>}</td>
                        <td>
                          <div className="row gap">
                            {hook ? (
                              <ActionButton meta={actions.data?.find((a) => a.id === 'plugins.run')} params={{ id: p.id, hook }} disabled={!p.enabled} onRun={(params) => void run('plugins.run', params)}>
                                Run {hook}
                              </ActionButton>
                            ) : (
                              <span className="muted small">
                                Runs during the portal scan for <span className="mono">provider: {p.id}</span> entries in portals.yml
                              </span>
                            )}
                            {p.hasSkill && (
                              <button type="button" onClick={() => void showSkill(p.id)}>
                                Skill doc
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          )}
        </DataState>
        <Message message={message} />
        {error && (
          <p role="alert" className="danger-text">
            {error}
          </p>
        )}
      </div>
      {skill && (
        <div className="card" aria-label={`Skill document for ${skill.id}`}>
          <div className="row gap" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>
              {skill.id} skill <Pill tone="warn">untrusted plugin documentation</Pill>
            </h2>
            <button type="button" onClick={() => setSkill(null)}>
              Close
            </button>
          </div>
          <p className="muted small">Third-party text rendered sanitized. It is shown for your review and is never fed to a session from here.</p>
          <Md text={skill.markdown} />
        </div>
      )}
    </div>
  );
}

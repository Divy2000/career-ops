import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiGet, apiSend } from '../../lib/api';
import { describeError } from '../../lib/actions';
import { DataState } from '../../components/ui';
import type { AppSettings, AppSettingsRead } from '@shared/api';

export const useAppSettings = () => useQuery({ queryKey: ['system', 'settings'], queryFn: () => apiGet<AppSettingsRead>('/api/settings/app') });

export function useSaveSettings() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const save = async (patch: Partial<AppSettings>, okText: string) => {
    setError(null);
    try {
      await apiSend('PUT', '/api/settings/app', patch);
      toast.success(okText);
      await Promise.all([qc.invalidateQueries({ queryKey: ['system', 'settings'] }), qc.invalidateQueries({ queryKey: ['system', 'usage'] })]);
      return true;
    } catch (err) {
      setError(`Could not save settings: ${describeError(err)}`);
      toast.error('Settings not saved');
      return false;
    }
  };
  return { save, error };
}

/** App settings: logos opt-in and run retention (spec 2.14 App). */
export function AppTab() {
  const q = useAppSettings();
  const { save, error } = useSaveSettings();
  const [retention, setRetention] = useState<string | null>(null);
  const s = q.data;
  return (
    <div className="card" aria-labelledby="app-settings-heading">
      <h2 id="app-settings-heading">App</h2>
      <DataState query={q}>
        {s && (
          <div className="fields">
            {s.problem && (
              <p role="alert" className="danger-text small">
                {s.problem} Defaults are in effect until the next save.
              </p>
            )}
            <div className="fields__row">
              <label className="fields__label" htmlFor="setting-logos">
                Company logos
                <span className="faint small">Off by default (monograms). On enables a disk-cached favicon proxy, which fetches from the web.</span>
              </label>
              <div className="fields__value">
                <input id="setting-logos" type="checkbox" checked={s.logos} onChange={(e) => void save({ logos: e.target.checked }, e.target.checked ? 'Logos enabled' : 'Logos disabled')} />
              </div>
            </div>
            <div className="fields__row">
              <label className="fields__label" htmlFor="setting-retention">
                Run retention
                <span className="faint small">Finished script runs kept under data/control-center/runs (50 to 5000). Sessions are kept until you delete them.</span>
              </label>
              <div className="fields__value row gap">
                <input id="setting-retention" type="number" min={50} max={5000} value={retention ?? String(s.retention)} onChange={(e) => setRetention(e.target.value)} />
                <button
                  type="button"
                  disabled={retention === null || Number(retention) === s.retention}
                  onClick={() =>
                    void save({ retention: Number(retention) }, 'Retention saved').then((ok) => {
                      if (ok) setRetention(null);
                    })
                  }
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="danger-text">
            {error}
          </p>
        )}
      </DataState>
    </div>
  );
}

/** Claude engine knobs: concurrency, model default and usage budgets. */
export function EngineSettings() {
  const q = useAppSettings();
  const { save, error } = useSaveSettings();
  const [model, setModel] = useState<string | null>(null);
  const [budget5, setBudget5] = useState<string | null>(null);
  const [budget7, setBudget7] = useState<string | null>(null);
  const s = q.data;
  const toBudget = (v: string | null, current: number | null) => (v === null ? current : v.trim() === '' ? null : Number(v));
  return (
    <DataState query={q}>
      {s && (
        <div className="fields">
          <div className="fields__row">
            <label className="fields__label" htmlFor="setting-concurrency">
              Claude concurrency
              <span className="faint small">Sessions running at once (1 to 4). Applies immediately to the queue.</span>
            </label>
            <div className="fields__value">
              <select id="setting-concurrency" value={s.claudeConcurrency} onChange={(e) => void save({ claudeConcurrency: Number(e.target.value) }, `Concurrency set to ${e.target.value}`)}>
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="fields__row">
            <label className="fields__label" htmlFor="setting-model">
              Model default
              <span className="faint small">Used when a session does not pick a model. Empty keeps the CLI default.</span>
            </label>
            <div className="fields__value row gap">
              <input id="setting-model" value={model ?? s.modelDefault} placeholder="CLI default" onChange={(e) => setModel(e.target.value)} />
              <button type="button" disabled={model === null || model === s.modelDefault} onClick={() => void save({ modelDefault: model ?? '' }, 'Model default saved').then((ok) => ok && setModel(null))}>
                Save
              </button>
            </div>
          </div>
          <div className="fields__row">
            <label className="fields__label" htmlFor="setting-budget-5h">
              Usage budgets (tokens)
              <span className="faint small">Shown on the sidebar meter. Empty means no budget.</span>
            </label>
            <div className="fields__value row gap">
              <input id="setting-budget-5h" aria-label="5 hour token budget" type="number" min={1} placeholder="5h" value={budget5 ?? (s.usageBudgets.fiveHourTokens ?? '')} onChange={(e) => setBudget5(e.target.value)} />
              <input aria-label="7 day token budget" type="number" min={1} placeholder="7d" value={budget7 ?? (s.usageBudgets.sevenDayTokens ?? '')} onChange={(e) => setBudget7(e.target.value)} />
              <button
                type="button"
                disabled={budget5 === null && budget7 === null}
                onClick={() =>
                  void save({ usageBudgets: { fiveHourTokens: toBudget(budget5, s.usageBudgets.fiveHourTokens), sevenDayTokens: toBudget(budget7, s.usageBudgets.sevenDayTokens) } }, 'Budgets saved').then((ok) => {
                    if (ok) {
                      setBudget5(null);
                      setBudget7(null);
                    }
                  })
                }
              >
                Save budgets
              </button>
            </div>
          </div>
          {error && (
            <p role="alert" className="danger-text">
              {error}
            </p>
          )}
        </div>
      )}
    </DataState>
  );
}

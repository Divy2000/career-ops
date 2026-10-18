import { useMemo, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, apiGet, apiSend } from '../../lib/api';
import { describeError } from '../../lib/actions';
import { DataState } from '../../components/ui';
import { AppearanceSetting } from '../../components/AppearanceSetting';
import { useUnsaved } from '../../lib/unsaved';
import type { AppSettings, AppSettingsRead } from '@shared/api';

const SETTINGS_KEY = ['system', 'settings'];

// The server takes app-settings patches without an ETag, in the order they arrive, so two writes on their way at once
// could land older last and undo the user's latest choice. Each write waits for the one before it to answer, in this
// tab through the queue and across the browser's tabs through a Web Lock (granted in request order).
let writeQueue: Promise<unknown> = Promise.resolve();
const WRITE_LOCK = 'career-ops-app-settings-write';
const withWriteLock = <T,>(send: () => Promise<T>): Promise<T> => (typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request(WRITE_LOCK, send) : send());

// Patches sent and not yet answered, oldest first. Every view of the settings shows them over the server's read, so a
// control changed again before its save answers starts from the user's latest choice, not the last read.
let unanswered: ReadonlyArray<Partial<AppSettings>> = [];
const listeners = new Set<() => void>();
const setUnanswered = (next: ReadonlyArray<Partial<AppSettings>>) => {
  unanswered = next;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const applyPatch = (s: AppSettingsRead, patch: Partial<AppSettings>): AppSettingsRead => ({ ...s, ...patch, usageBudgets: { ...s.usageBudgets, ...(patch.usageBudgets ?? {}) } });

const queueWrite = (patch: Partial<AppSettings>, reset: boolean) => {
  const url = reset ? '/api/settings/app?reset=1' : '/api/settings/app';
  const write = writeQueue.then(() => withWriteLock(() => apiSend<AppSettings>('PUT', url, patch)));
  writeQueue = write.catch(() => undefined);
  return write;
};

/** The settings as the user last chose them: the server's read with every unanswered save on top. */
export function useAppSettings(): UseQueryResult<AppSettingsRead> {
  const q = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => apiGet<AppSettingsRead>('/api/settings/app') });
  const patches = useSyncExternalStore(subscribe, () => unanswered);
  const data = useMemo(() => (q.data ? patches.reduce(applyPatch, q.data) : undefined), [q.data, patches]);
  return { ...q, data } as UseQueryResult<AppSettingsRead>;
}

export function useSaveSettings() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  // A write the server refused because settings.json could not be read: sent again only if the user asks to replace the file.
  const [refused, setRefused] = useState<{ patch: Partial<AppSettings>; okText: string } | null>(null);
  const save = async (patch: Partial<AppSettings>, okText: string, reset = false) => {
    setError(null);
    setRefused(null);
    setUnanswered([...unanswered, patch]);
    try {
      try {
        const written = await queueWrite(patch, reset);
        // A read started before this write may answer after it: it is dropped, and the written settings shown until the refetch.
        await qc.cancelQueries({ queryKey: SETTINGS_KEY });
        qc.setQueryData<AppSettingsRead>(SETTINGS_KEY, { ...written, problem: null });
      } finally {
        setUnanswered(unanswered.filter((p) => p !== patch));
      }
      toast.success(okText);
      await Promise.all([qc.invalidateQueries({ queryKey: SETTINGS_KEY }), qc.invalidateQueries({ queryKey: ['system', 'usage'] })]);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && (err.body as { code?: unknown } | null)?.code === 'settings-problem') setRefused({ patch, okText });
      setError(`Could not save settings: ${describeError(err)}`);
      toast.error('Settings not saved');
      return false;
    }
  };
  const replace = refused ? () => save(refused.patch, refused.okText, true) : null;
  return { save, error, replace };
}

function SaveError({ error, replace }: { error: string | null; replace: (() => Promise<boolean>) | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="danger-text row gap">
      <p>{error}</p>
      {replace && (
        <button type="button" onClick={() => void replace()}>
          Replace settings.json
        </button>
      )}
    </div>
  );
}

/** After a save answers, its draft is cleared only if the user has not typed past what it sent. */
const keepNewer =
  (sent: string | null) =>
  (current: string | null): string | null =>
    current === sent ? null : current;

/** Both settings tabs read and write the same file, so each says when it could not be read and shows defaults. */
function SettingsProblem({ problem }: { problem: string | null }) {
  if (!problem) return null;
  return (
    <p role="alert" className="danger-text small">
      {problem} Defaults are in effect; a save asks before replacing the file.
    </p>
  );
}

/** App settings: logos opt-in and run retention (spec 2.14 App). */
export function AppTab() {
  const q = useAppSettings();
  const { save, error, replace } = useSaveSettings();
  const [retention, setRetention] = useState<string | null>(null);
  const s = q.data;
  useUnsaved('the run retention', retention !== null && s !== undefined && Number(retention) !== s.retention);
  return (
    <div className="card" aria-labelledby="app-settings-heading">
      <h2 id="app-settings-heading">App</h2>
      <DataState query={q}>
        {s && (
          <div className="fields">
            <SettingsProblem problem={s.problem} />
            <AppearanceSetting />
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
                  onClick={() => {
                    const sent = retention;
                    void save({ retention: Number(sent) }, 'Retention saved').then((ok) => {
                      if (ok) setRetention(keepNewer(sent));
                    });
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        )}
        <SaveError error={error} replace={replace} />
      </DataState>
    </div>
  );
}

/** Claude engine knobs: concurrency, model default and usage budgets. */
export function EngineSettings() {
  const q = useAppSettings();
  const { save, error, replace } = useSaveSettings();
  const [model, setModel] = useState<string | null>(null);
  const [budget5, setBudget5] = useState<string | null>(null);
  const [budget7, setBudget7] = useState<string | null>(null);
  const s = q.data;
  const toBudget = (v: string | null, current: number | null) => (v === null ? current : v.trim() === '' ? null : Number(v));
  useUnsaved('the model default', model !== null && s !== undefined && model !== s.modelDefault);
  useUnsaved('the token budgets', s !== undefined && (toBudget(budget5, s.usageBudgets.fiveHourTokens) !== s.usageBudgets.fiveHourTokens || toBudget(budget7, s.usageBudgets.sevenDayTokens) !== s.usageBudgets.sevenDayTokens));
  return (
    <DataState query={q}>
      {s && (
        <div className="fields">
          <SettingsProblem problem={s.problem} />
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
              <button type="button" disabled={model === null || model === s.modelDefault} onClick={() => {
                  const sent = model;
                  void save({ modelDefault: sent ?? '' }, 'Model default saved').then((ok) => ok && setModel(keepNewer(sent)));
                }}>
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
                onClick={() => {
                  const [sent5, sent7] = [budget5, budget7];
                  void save({ usageBudgets: { fiveHourTokens: toBudget(sent5, s.usageBudgets.fiveHourTokens), sevenDayTokens: toBudget(sent7, s.usageBudgets.sevenDayTokens) } }, 'Budgets saved').then((ok) => {
                    if (ok) {
                      setBudget5(keepNewer(sent5));
                      setBudget7(keepNewer(sent7));
                    }
                  });
                }}
              >
                Save budgets
              </button>
            </div>
          </div>
          <SaveError error={error} replace={replace} />
        </div>
      )}
    </DataState>
  );
}

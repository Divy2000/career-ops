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

// Invariants this module keeps: AppTab.invariants.md.

/**
 * The server's read carries the file's version (ETag); a write sends it so a change made elsewhere is refused, not
 * overwritten. `ownAt` is this browser's own-write counter when the read was asked for (see OwnWrite).
 */
type VersionedRead = AppSettingsRead & { etag?: string; ownAt?: number };
type Written = AppSettings & { etag?: string };

// Each write waits for the one before it to answer, in this tab through the queue and across the browser's tabs
// through a Web Lock (granted in request order), so the user's latest choice lands last.
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

// This browser's own writes, shared by its tabs: how many it has had taken (n) and the latest of them, each with the
// version it was sent against (null: none) and the version it left. Only a write holding the Web Lock reads and
// replaces this. Versions name the file's content and repeat, so only the counter says whether a read is older than a
// write.
type OwnWrites = { n: number; writes: Array<{ from: string | null; to: string }> };
const OWN_KEY = 'career-ops-app-settings-own-writes';
const OWN_MAX = 40;
// This tab's copy: what it uses when storage cannot be written (blocked, full), so its own saves still follow each other.
let ownHere: OwnWrites = { n: 0, writes: [] };
let storageWorks = true;
const isWrite = (w: unknown): w is OwnWrites['writes'][number] => !!w && typeof (w as { to?: unknown }).to === 'string' && ((w as { from?: unknown }).from === null || typeof (w as { from?: unknown }).from === 'string');
const readOwn = (): OwnWrites => {
  if (!storageWorks) return ownHere;
  try {
    const raw = JSON.parse(localStorage.getItem(OWN_KEY) ?? 'null') as Partial<OwnWrites> | null;
    if (raw && Number.isSafeInteger(raw.n) && Array.isArray(raw.writes) && raw.writes.every(isWrite) && raw.writes.length <= raw.n!) return { n: raw.n!, writes: raw.writes };
    return ownHere;
  } catch {
    return ownHere;
  }
};
const storeOwn = (own: OwnWrites) => {
  ownHere = own;
  try {
    localStorage.setItem(OWN_KEY, JSON.stringify(own));
  } catch {
    storageWorks = false;
  }
};

/**
 * The version a write is checked against. A read is behind only this browser's tabs (the Web Lock ordered their
 * writes) when one of its own writes since that read was sent against the read's version, and no later own write was
 * sent against a version other than the one before it left (that one wrote on top of a change made elsewhere, which
 * the read never showed). Such a read is written on top of the latest own write; any other read as it is, and a
 * change made elsewhere since is refused.
 */
const ifMatchFor = (read: VersionedRead | undefined, own: OwnWrites): string | undefined => {
  if (read?.etag === undefined) return undefined;
  if (read.ownAt === undefined) return read.etag;
  const first = own.n - own.writes.length;
  for (let i = own.writes.length - 1; i >= 0 && first + i >= read.ownAt; i--) {
    const w = own.writes[i]!;
    if (w.from === read.etag) return own.writes.at(-1)!.to;
    if (i > 0 && w.from !== own.writes[i - 1]!.to) break;
  }
  return read.etag;
};

/** A write's answer: the settings it left, or why it was refused, each as a read tagged with the counter it was answered at. */
type WriteAnswer = { ok: true; read: VersionedRead } | { ok: false; error: unknown; ownAt: number | undefined };

/**
 * `base` is the read the patch was made from, taken when the save starts: a read the cache gets later (a refusal's
 * current values, a refetch) never showed the user what this patch keeps, so it must not become its version.
 */
const queueWrite = (patch: Partial<AppSettings>, reset: boolean, base: VersionedRead | undefined): Promise<WriteAnswer> => {
  const url = reset ? '/api/settings/app?reset=1' : '/api/settings/app';
  const send = async (): Promise<WriteAnswer> => {
    const own = readOwn();
    const ifMatch = ifMatchFor(base, own);
    try {
      const written = await apiSend<Written>('PUT', url, patch, ifMatch === undefined ? {} : { 'if-match': ifMatch });
      if (!written.etag) return { ok: true, read: { ...written, problem: null } };
      storeOwn({ n: own.n + 1, writes: [...own.writes, { from: ifMatch ?? null, to: written.etag }].slice(-OWN_MAX) });
      return { ok: true, read: { ...written, problem: null, ownAt: own.n + 1 } };
    } catch (error) {
      return { ok: false, error, ownAt: own.n };
    }
  };
  const write = writeQueue.then(() => withWriteLock(send)).catch((error: unknown): WriteAnswer => ({ ok: false, error, ownAt: undefined }));
  writeQueue = write;
  return write;
};

/** The settings as the user last chose them: the server's read with every unanswered save on top. */
export function useAppSettings(): UseQueryResult<AppSettingsRead> {
  const q = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: async (): Promise<VersionedRead> => {
      const ownAt = readOwn().n;
      return { ...(await apiGet<VersionedRead>('/api/settings/app')), ownAt };
    },
  });
  const patches = useSyncExternalStore(subscribe, () => unanswered);
  const data = useMemo(() => (q.data ? patches.reduce(applyPatch, q.data) : undefined), [q.data, patches]);
  return { ...q, data } as UseQueryResult<AppSettingsRead>;
}

type Refusal = { code?: unknown; current?: VersionedRead } | null;
const refusalOf = (error: unknown): Refusal => (error instanceof ApiError && error.status === 409 ? (error.body as Refusal) : null);

export function useSaveSettings() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  // A write the server refused because settings.json could not be read: sent again only if the user asks to replace the file.
  const [refused, setRefused] = useState<{ patch: Partial<AppSettings>; okText: string; onSaved?: () => void } | null>(null);
  /** `onSaved` runs once the patch is taken, also when it is taken only after the user asks to replace the file. */
  const save = async (patch: Partial<AppSettings>, okText: string, opts: { onSaved?: () => void; reset?: boolean } = {}) => {
    const { onSaved, reset = false } = opts;
    setError(null);
    setRefused(null);
    setUnanswered([...unanswered, patch]);
    let answer: WriteAnswer;
    try {
      answer = await queueWrite(patch, reset, qc.getQueryData<VersionedRead>(SETTINGS_KEY));
      // Taken: the written settings. Changed elsewhere: the latest values, for the user to check and save again (the
      // fields' drafts are kept). A read started before this answer may land after it, so it is dropped first.
      const refusal = answer.ok ? null : refusalOf(answer.error);
      const shown = answer.ok ? answer.read : refusal?.code === 'settings-changed' && refusal.current ? { ...refusal.current, ownAt: answer.ownAt } : null;
      if (shown) {
        await qc.cancelQueries({ queryKey: SETTINGS_KEY });
        qc.setQueryData<VersionedRead>(SETTINGS_KEY, shown);
      }
    } finally {
      setUnanswered(unanswered.filter((p) => p !== patch));
    }
    if (answer.ok) {
      onSaved?.();
      toast.success(okText);
      await Promise.all([qc.invalidateQueries({ queryKey: SETTINGS_KEY }), qc.invalidateQueries({ queryKey: ['system', 'usage'] })]);
      return true;
    }
    const code = refusalOf(answer.error)?.code;
    if (code === 'settings-problem') setRefused({ patch, okText, onSaved });
    if (code === 'settings-changed') void qc.invalidateQueries({ queryKey: SETTINGS_KEY });
    setError(`Could not save settings: ${describeError(answer.error)}`);
    toast.error('Settings not saved');
    return false;
  };
  const replace = refused ? () => save(refused.patch, refused.okText, { onSaved: refused.onSaved, reset: true }) : null;
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
                    void save({ retention: Number(sent) }, 'Retention saved', { onSaved: () => setRetention(keepNewer(sent)) });
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
                  void save({ modelDefault: sent ?? '' }, 'Model default saved', { onSaved: () => setModel(keepNewer(sent)) });
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
                  void save({ usageBudgets: { fiveHourTokens: toBudget(sent5, s.usageBudgets.fiveHourTokens), sevenDayTokens: toBudget(sent7, s.usageBudgets.sevenDayTokens) } }, 'Budgets saved', {
                    onSaved: () => {
                      setBudget5(keepNewer(sent5));
                      setBudget7(keepNewer(sent7));
                    },
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

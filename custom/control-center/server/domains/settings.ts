// App settings (spec 2.14 App and AI engine): a small JSON file under the
// data root. Logos stay opt-in, retention and the Claude slot cap feed the
// runner, the model default feeds new sessions, budgets feed the usage meter.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const appSettingsSchema = z.object({
  logos: z.boolean(),
  retention: z.number().int().min(50).max(5000),
  claudeConcurrency: z.number().int().min(1).max(4),
  /** Empty string means the CLI default. */
  modelDefault: z.string().regex(/^[\w.-]*$/, 'model ids use letters, digits, dots and dashes').max(60),
  usageBudgets: z.object({ fiveHourTokens: z.number().int().positive().nullable(), sevenDayTokens: z.number().int().positive().nullable() }),
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const appSettingsPatchSchema = appSettingsSchema.partial().strict();

// What settings.json may hold: any setting may be missing, each budget too, and mergeSettings fills the missing ones.
const storedSettingsSchema = appSettingsSchema.extend({ usageBudgets: appSettingsSchema.shape.usageBudgets.partial() }).partial();
type StoredSettings = z.infer<typeof storedSettingsSchema>;

export const DEFAULT_SETTINGS: AppSettings = { logos: false, retention: 500, claudeConcurrency: 2, modelDefault: '', usageBudgets: { fiveHourTokens: null, sevenDayTokens: null } };

export const SETTINGS_REL = 'data/control-center/settings.json';

export function mergeSettings(current: StoredSettings, patch: Partial<AppSettings>): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...current,
    ...patch,
    usageBudgets: { ...DEFAULT_SETTINGS.usageBudgets, ...(current.usageBudgets ?? {}), ...(patch.usageBudgets ?? {}) },
  };
}

/**
 * `readable` is false when nothing in settings.json could be used (half-typed JSON, not an object, every known value
 * invalid): `settings` are then only the defaults, not what the user wrote.
 */
export type SettingsRead = { settings: AppSettings; problem: string | null; readable: boolean; etag: string };

/** The version a write is checked against: the file's bytes, so a hand edit counts as a change too. */
const ABSENT_ETAG = 'none';
const etagOf = (raw: string) => crypto.createHash('sha256').update(raw).digest('hex').slice(0, 20);

/** Fields of settings.json this version does not know (a newer version's, a hand-added one), kept through a save. */
type UnknownFields = { top: Record<string, unknown>; usageBudgets: Record<string, unknown> };
const NO_UNKNOWN: UnknownFields = { top: {}, usageBudgets: {} };

/** Missing or malformed settings fall back to the defaults; the problem is reported, never swallowed silently. */
export function readSettings(dataRoot: string): SettingsRead {
  const { unknown: _unknown, ...read } = readSettingsFile(dataRoot);
  return read;
}

function readSettingsFile(dataRoot: string): SettingsRead & { unknown: UnknownFields } {
  const abs = path.join(dataRoot, SETTINGS_REL);
  let raw: string;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { settings: DEFAULT_SETTINGS, problem: null, readable: true, etag: ABSENT_ETAG, unknown: NO_UNKNOWN };
    throw err;
  }
  return { ...parseSettings(raw), etag: etagOf(raw) };
}

function parseSettings(raw: string): { settings: AppSettings; problem: string | null; readable: boolean; unknown: UnknownFields } {
  let rawValue: unknown;
  try {
    rawValue = JSON.parse(raw);
  } catch (err) {
    return { settings: DEFAULT_SETTINGS, problem: `settings.json is not valid JSON: ${(err as Error).message}`, readable: false, unknown: NO_UNKNOWN };
  }
  const unknown = unknownFields(rawValue);
  const parsed = storedSettingsSchema.safeParse(rawValue);
  if (parsed.success) return { settings: mergeSettings(parsed.data, {}), problem: null, readable: true, unknown };
  // One bad value must not reset its valid neighbors: a one-field PUT over such a file keeps every good setting.
  const kept = keepValidSettings(rawValue);
  const { usageBudgets, ...keptTop } = kept;
  const readable = Object.keys(keptTop).length > 0 || Object.keys(usageBudgets ?? {}).length > 0;
  return { settings: mergeSettings(kept, {}), problem: `settings.json has invalid values: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`, readable, unknown };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function unknownFields(raw: unknown): UnknownFields {
  if (!isRecord(raw)) return NO_UNKNOWN;
  const pick = (obj: Record<string, unknown>, known: Record<string, unknown>) => Object.fromEntries(Object.entries(obj).filter(([k]) => !Object.hasOwn(known, k)));
  return { top: pick(raw, appSettingsSchema.shape), usageBudgets: isRecord(raw.usageBudgets) ? pick(raw.usageBudgets, appSettingsSchema.shape.usageBudgets.shape) : {} };
}

/** Each top-level field parsed alone, so a file with one invalid value keeps the rest instead of falling back to defaults. */
function keepValidSettings(raw: unknown): StoredSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(appSettingsSchema.shape)) {
    const field = schema.safeParse(obj[key]);
    if (field.success) out[key] = field.data;
  }
  // The budgets are two settings in one object: one bad budget keeps the other (mergeSettings fills the missing one).
  const budgets = obj.usageBudgets;
  if (!('usageBudgets' in out) && budgets && typeof budgets === 'object' && !Array.isArray(budgets)) {
    const kept: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(appSettingsSchema.shape.usageBudgets.shape)) {
      const field = schema.safeParse((budgets as Record<string, unknown>)[key]);
      if (field.success) kept[key] = field.data;
    }
    out.usageBudgets = kept;
  }
  return out as StoredSettings;
}

/** The model a new session runs on: the one the request names, else the app default, else null (the CLI default). */
export function sessionModel(dataRoot: string, requested: string | null | undefined): string | null {
  return requested ?? (readSettings(dataRoot).settings.modelDefault || null);
}

export type SettingsUpdate =
  | { ok: true; settings: AppSettings; etag: string }
  | { ok: false; code: 'settings-changed'; current: SettingsRead }
  | { ok: false; code: 'settings-problem'; problem: string };

/**
 * A patch saved from the app. With `ifMatch` (the ETag of the caller's last read) it is refused when the file changed
 * since, so a write from another browser or device is not silently overwritten; without it the patch merges as before.
 * A settings.json that could not be read is only replaced when the caller opts in: the user's file would otherwise
 * become the defaults (or its valid fields) plus one change without them knowing. Check and write are synchronous, so
 * no other request of this server runs between them.
 */
export function updateSettings(dataRoot: string, patch: Partial<AppSettings>, opts: { reset?: boolean; ifMatch?: string } = {}): SettingsUpdate {
  const { unknown, ...current } = readSettingsFile(dataRoot);
  const ifMatch = opts.ifMatch?.replace(/^(W\/)?"|"$/g, '');
  if (ifMatch !== undefined && ifMatch !== '*' && ifMatch !== current.etag) return { ok: false, code: 'settings-changed', current };
  if (current.problem && !opts.reset) return { ok: false, code: 'settings-problem', problem: current.problem };
  const next = appSettingsSchema.parse(mergeSettings(current.settings, patch));
  return { ok: true, settings: next, etag: persistSettings(dataRoot, next, unknown) };
}

/** Writes the settings, with the fields this version does not know as they were, atomically and answers the new ETag. */
function persistSettings(dataRoot: string, next: AppSettings, unknown: UnknownFields): string {
  const abs = path.join(dataRoot, SETTINGS_REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  const raw = JSON.stringify({ ...unknown.top, ...next, usageBudgets: { ...unknown.usageBudgets, ...next.usageBudgets } }, null, 2) + '\n';
  try {
    fs.writeFileSync(tmp, raw);
    fs.renameSync(tmp, abs);
  } catch (err) {
    // A failed cleanup must not hide why the write failed.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* the write error below is the one to report */
    }
    throw err;
  }
  return etagOf(raw);
}

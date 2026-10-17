// App settings (spec 2.14 App and AI engine): a small JSON file under the
// data root. Logos stay opt-in, retention and the Claude slot cap feed the
// runner, the model default feeds new sessions, budgets feed the usage meter.
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

export const DEFAULT_SETTINGS: AppSettings = { logos: false, retention: 500, claudeConcurrency: 2, modelDefault: '', usageBudgets: { fiveHourTokens: null, sevenDayTokens: null } };

export const SETTINGS_REL = 'data/control-center/settings.json';

export function mergeSettings(current: Partial<AppSettings>, patch: Partial<AppSettings>): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...current,
    ...patch,
    usageBudgets: { ...DEFAULT_SETTINGS.usageBudgets, ...(current.usageBudgets ?? {}), ...(patch.usageBudgets ?? {}) },
  };
}

/** Missing or malformed settings fall back to the defaults; the problem is reported, never swallowed silently. */
export function readSettings(dataRoot: string): { settings: AppSettings; problem: string | null } {
  const abs = path.join(dataRoot, SETTINGS_REL);
  let raw: string;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { settings: DEFAULT_SETTINGS, problem: null };
    throw err;
  }
  try {
    const rawValue: unknown = JSON.parse(raw);
    const parsed = appSettingsSchema.partial().safeParse(rawValue);
    if (parsed.success) return { settings: mergeSettings(parsed.data, {}), problem: null };
    // One bad value must not reset its valid neighbors: a one-field PUT over such a file keeps every good setting.
    const kept = keepValidSettings(rawValue);
    return { settings: mergeSettings(kept, {}), problem: `settings.json has invalid values: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}` };
  } catch (err) {
    return { settings: DEFAULT_SETTINGS, problem: `settings.json is not valid JSON: ${(err as Error).message}` };
  }
}

/** Each top-level field parsed alone, so a file with one invalid value keeps the rest instead of falling back to defaults. */
function keepValidSettings(raw: unknown): Partial<AppSettings> {
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
  return out as Partial<AppSettings>;
}

/** The model a new session runs on: the one the request names, else the app default, else null (the CLI default). */
export function sessionModel(dataRoot: string, requested: string | null | undefined): string | null {
  return requested ?? (readSettings(dataRoot).settings.modelDefault || null);
}

export function writeSettings(dataRoot: string, patch: Partial<AppSettings>): AppSettings {
  const next = appSettingsSchema.parse(mergeSettings(readSettings(dataRoot).settings, patch));
  const abs = path.join(dataRoot, SETTINGS_REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
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
  return next;
}

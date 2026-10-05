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
    const parsed = appSettingsSchema.partial().safeParse(JSON.parse(raw));
    if (!parsed.success) return { settings: DEFAULT_SETTINGS, problem: `settings.json has invalid values: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}` };
    return { settings: mergeSettings(parsed.data, {}), problem: null };
  } catch (err) {
    return { settings: DEFAULT_SETTINGS, problem: `settings.json is not valid JSON: ${(err as Error).message}` };
  }
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
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, abs);
  return next;
}

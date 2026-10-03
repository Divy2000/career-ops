// Plugin discovery (plugins/*/manifest.json, plugins.local/*) joined with the
// user's opt-in state in config/plugins.yml (data root, gitignored).
import fs from 'node:fs';
import path from 'node:path';
import { parseYamlDoc } from './yamlOps.js';
import { etagOf } from './files.js';

export const PLUGINS_CONFIG_REL = 'config/plugins.yml';

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  version: string;
  hooks: string[];
  requiredEnv: string[];
  optionalEnv: string[];
  humanInTheLoop: boolean;
  hasSkill: boolean;
  source: 'bundled' | 'local';
  /** true when config/plugins.yml has `plugins.<id>.enabled: true`. */
  enabled: boolean;
  /** true when the id appears in config/plugins.yml at all. */
  configured: boolean;
}

export interface PluginsConfigRead {
  kind: 'ok' | 'missing' | 'malformed';
  path: string;
  raw: string;
  etag: string | null;
  error?: string;
}

export interface PluginsRead {
  plugins: PluginInfo[];
  config: PluginsConfigRead;
}

export function readPluginsConfig(dataRoot: string): PluginsConfigRead & { doc: Record<string, unknown> | null } {
  const abs = path.join(dataRoot, PLUGINS_CONFIG_REL);
  let raw: string;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', path: PLUGINS_CONFIG_REL, raw: '', etag: null, doc: null };
    throw err;
  }
  const parsed = parseYamlDoc(raw);
  if (parsed.parseError) return { kind: 'malformed', path: PLUGINS_CONFIG_REL, raw, etag: etagOf(raw), error: parsed.parseError, doc: null };
  return { kind: 'ok', path: PLUGINS_CONFIG_REL, raw, etag: etagOf(raw), doc: (parsed.doc as Record<string, unknown>) ?? {} };
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function scanDir(dir: string, source: PluginInfo['source']): Array<Omit<PluginInfo, 'enabled' | 'configured'>> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<Omit<PluginInfo, 'enabled' | 'configured'>> = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const manifestPath = path.join(dir, e.name, 'manifest.json');
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = typeof m.id === 'string' ? m.id : e.name;
    const skill = typeof m.skill === 'string' ? m.skill : 'skill.md';
    out.push({
      id,
      name: typeof m.name === 'string' ? m.name : id,
      description: typeof m.description === 'string' ? m.description : '',
      version: typeof m.version === 'string' ? m.version : '',
      hooks: asStrings(m.hooks),
      requiredEnv: asStrings(m.requiredEnv),
      optionalEnv: asStrings(m.optionalEnv),
      humanInTheLoop: m.humanInTheLoop === true,
      hasSkill: fs.existsSync(path.join(dir, e.name, skill)),
      source,
    });
  }
  return out;
}

export function listPlugins(codeRoot: string, dataRoot: string): PluginsRead {
  const config = readPluginsConfig(dataRoot);
  const table = (config.doc?.plugins ?? {}) as Record<string, unknown>;
  const found = [...scanDir(path.join(codeRoot, 'plugins'), 'bundled'), ...scanDir(path.join(codeRoot, 'plugins.local'), 'local')];
  const plugins = found
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => {
      const entry = table && typeof table === 'object' ? (table[p.id] as Record<string, unknown> | undefined) : undefined;
      return { ...p, configured: entry !== undefined, enabled: Boolean(entry && typeof entry === 'object' && entry.enabled === true) };
    });
  const { doc: _doc, ...rest } = config;
  return { plugins, config: rest };
}

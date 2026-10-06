// Plugin discovery (plugins/*/manifest.json, plugins.local/*) joined with the
// user's opt-in state in config/plugins.yml (data root, gitignored).
import fs from 'node:fs';
import path from 'node:path';
import { parseYamlDoc } from './yamlOps.js';
import { etagOf } from './files.js';
import { importCore } from '../core/adapter.js';

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

interface EngineManifest {
  id: string;
  name?: string;
  description: string;
  version?: string;
  hooks: string[];
  requiredEnv: string[];
  optionalEnv: string[];
  humanInTheLoop: boolean;
  skill: string | null;
  dir: string;
}

interface PluginEngine {
  discoverPlugins: (roots: string[], overrideIds?: Set<string>) => EngineManifest[];
  resolveSuccessorIds: (root: string) => Set<string>;
}

/**
 * The plugins plugins.mjs knows, found by its own engine (plugins/_engine.mjs): a symlinked plugins.local checkout
 * counts, an invalid manifest (no id, an id that is not the folder name) is skipped, and the first root wins for an id
 * (bundled plugins/ before plugins.local/, unless a registered successor overrides it). `localDir` replaces
 * <codeRoot>/plugins.local (tests).
 */
export async function listPlugins(codeRoot: string, dataRoot: string, localDir: string = path.join(codeRoot, 'plugins.local')): Promise<PluginsRead> {
  const config = readPluginsConfig(dataRoot);
  const table = (config.doc?.plugins ?? {}) as Record<string, unknown>;
  const engine = await importCore<PluginEngine>(codeRoot, 'plugins/_engine.mjs');
  const bundledDir = path.join(codeRoot, 'plugins');
  const found = engine.discoverPlugins([bundledDir, localDir], engine.resolveSuccessorIds(codeRoot));
  const plugins = found
    .map((m): PluginInfo => {
      const entry = table && typeof table === 'object' ? (table[m.id] as Record<string, unknown> | undefined) : undefined;
      return {
        id: m.id,
        name: m.name ?? m.id,
        description: m.description,
        version: m.version ?? '',
        hooks: [...m.hooks],
        requiredEnv: [...m.requiredEnv],
        optionalEnv: [...m.optionalEnv],
        humanInTheLoop: m.humanInTheLoop,
        hasSkill: m.skill !== null,
        source: m.dir.startsWith(bundledDir + path.sep) ? 'bundled' : 'local',
        configured: entry !== undefined,
        enabled: Boolean(entry && typeof entry === 'object' && entry.enabled === true),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const { doc: _doc, ...rest } = config;
  return { plugins, config: rest };
}

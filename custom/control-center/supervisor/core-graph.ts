// The files behind the core modules the server child loads with importCore (server/core/contract.json):
// each contracted module and everything it imports, transitively, inside the code root. Node caches an ES
// module for the life of the process, and a module re-imported under a new URL still gets its old
// dependencies, so a fresh copy of one file cannot pick up a changed import. The supervisor watches this
// graph and restarts the server child (a blue/green reload) when any file in it changes: the new process
// loads the whole graph anew.
import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';

// Static and dynamic imports with a literal relative specifier. A match inside a comment or a string only
// adds a path to watch (at worst, creating that file restarts the child once), so over-matching is harmless.
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.\.?\/[^'"\n]+)\1/g;

/** A TypeScript module names a sibling by its .js output (`./app.js` for app.ts): the source is the file loaded. */
function sourceOf(file: string): string {
  if (!file.endsWith('.js') || fs.existsSync(file)) return file;
  const ts = `${file.slice(0, -3)}.ts`;
  return fs.existsSync(ts) ? ts : file;
}

/**
 * The graph as code-root-relative paths (posix separators), sorted: the files that exist, and the relative imports
 * that name a file that does not exist yet (`missing`). A module may import a file before it is written, Dev Chat
 * editing the importer first; the watcher watches those too, so the file's creation restarts the child.
 */
export function coreImportGraphWithMissing(codeRoot: string, entries: readonly string[]): { files: string[]; missing: string[] } {
  const root = path.resolve(codeRoot);
  const seen = new Set<string>();
  const missing = new Set<string>();
  const queue = entries.map((e) => path.join(root, e));
  while (queue.length) {
    const file = queue.shift()!;
    const rel = path.relative(root, file);
    if (seen.has(rel) || missing.has(rel) || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).includes('node_modules')) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') missing.add(rel);
      continue;
    }
    seen.add(rel);
    for (const m of text.matchAll(IMPORT)) queue.push(sourceOf(path.resolve(path.dirname(file), m[2]!)));
  }
  const posix = (set: Set<string>) => [...set].map((r) => r.split(path.sep).join('/')).sort();
  return { files: posix(seen), missing: posix(missing) };
}

/** The graph's files that exist, as code-root-relative paths (posix separators), sorted. */
export function coreImportGraph(codeRoot: string, entries: readonly string[]): string[] {
  return coreImportGraphWithMissing(codeRoot, entries).files;
}

/** The package trees a server child runs from; the supervisor reloads it when a file in them changes. */
export const SERVER_TREES = ['server', 'shared'] as const;

/** Entries as given, or read anew on every use (the server trees gain and lose files). */
export type GraphEntries = readonly string[] | (() => readonly string[]);
const entriesOf = (entries: GraphEntries): readonly string[] => (typeof entries === 'function' ? entries() : entries);

/**
 * Where a server child's imports start: the contracted core modules (`core`), and every module of the package's server/
 * and shared/ trees, whose relative imports reach modules outside the package the server loads itself
 * (server/domains/policyPass.ts imports custom/immigration/policy-claim.mjs). Code-root-relative paths.
 */
export function serverEntries(codeRoot: string, packageRoot: string, core: readonly string[]): string[] {
  const root = path.resolve(codeRoot);
  const out = [...core];
  for (const tree of SERVER_TREES) {
    const dir = path.join(packageRoot, tree);
    let names: string[];
    try {
      names = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const name of names) if (/\.(ts|mjs|js)$/.test(name) && !name.split(path.sep).includes('node_modules')) out.push(path.relative(root, path.join(dir, name)));
  }
  return out;
}

/**
 * Whether a server child loads a code-root-relative path: a file in the package's server/ or shared/ tree, or in the
 * import graph of `entries` (serverEntries) as it is now.
 */
export function serverLoads(codeRoot: string, packageRoot: string, entries: GraphEntries): (rel: string) => boolean {
  const pkg = path.relative(fs.realpathSync(codeRoot), fs.realpathSync(packageRoot)).split(path.sep).join('/');
  const core = new Set(coreImportGraph(codeRoot, entriesOf(entries)));
  return (rel) => core.has(rel) || SERVER_TREES.some((tree) => rel.startsWith(`${pkg}/${tree}/`));
}

export interface CoreGraphWatcher {
  /** Recompute the graph (after a reload, it may import new files) and watch what it now holds. */
  refresh(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Calls `onChange(absolutePath)` when a file of the graph changes, is added (back) or is removed, a file that a module
 * imports before it exists included. Every event re-reads the graph, so an import a change adds is watched at once,
 * whether or not the reload it causes comes up; and a file such an import names that is already on disk by then (the
 * import and the file written back to back) is signalled as well, since watching an existing file reports nothing.
 */
export async function watchCoreGraph(codeRoot: string, entries: GraphEntries, onChange: (file: string) => void): Promise<CoreGraphWatcher> {
  const files = () => {
    const graph = coreImportGraphWithMissing(codeRoot, entriesOf(entries));
    return [...graph.files, ...graph.missing].map((rel) => path.join(codeRoot, rel));
  };
  let watched = new Set(files());
  const watcher = chokidar.watch([...watched], { ignoreInitial: true });
  const refresh = async () => {
    const next = new Set(files());
    const added = [...next].filter((f) => !watched.has(f));
    const gone = [...watched].filter((f) => !next.has(f));
    watched = next;
    if (gone.length) await watcher.unwatch(gone);
    if (added.length) watcher.add(added);
    for (const f of added) if (fs.existsSync(f)) onChange(f);
  };
  watcher.on('all', (_event, file) => {
    onChange(file);
    void refresh();
  });
  await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
  return { refresh, close: () => watcher.close() };
}

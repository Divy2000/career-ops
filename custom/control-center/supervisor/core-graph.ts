// The files behind the core modules the server child loads with importCore (server/core/contract.json):
// each contracted module and everything it imports, transitively, inside the code root. Node caches an ES
// module for the life of the process, and a module re-imported under a new URL still gets its old
// dependencies, so a fresh copy of one file cannot pick up a changed import. The supervisor watches this
// graph and restarts the server child (a blue/green reload) when any file in it changes: the new process
// loads the whole graph anew.
import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';

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
    for (const file of moduleFiles(path.join(packageRoot, tree))) out.push(path.relative(root, file));
  }
  return out;
}

const unreadable = new Set<string>();
const logError = (what: string, err: unknown) => console.error(`[supervisor] ${what}: ${err instanceof Error ? err.message : String(err)}`);

/**
 * The .ts/.mjs/.js files under `dir`, node_modules aside. A directory that cannot be read (gone, or unreadable, such as
 * a mode 000 folder a Dev Chat step left) is skipped: one bad subtree must not stop the supervisor watching the rest.
 */
function moduleFiles(dir: string): string[] {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // Every refresh and reload walks the trees again: report a folder once, not on every walk.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && !unreadable.has(dir)) {
      unreadable.add(dir);
      logError(`cannot read ${dir}; its modules are not watched`, err);
    }
    return [];
  }
  unreadable.delete(dir);
  const out: string[] = [];
  for (const d of dirents) {
    const file = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (d.name !== 'node_modules') out.push(...moduleFiles(file));
    } else if (/\.(ts|mjs|js)$/.test(d.name)) out.push(file);
  }
  return out;
}

/**
 * Watches the package's server/ and shared/ trees, calling `onChange(absolutePath)` on every change. A path chokidar
 * cannot watch (EACCES on a new mode 000 folder) is logged: an 'error' event with no listener would exit the supervisor.
 */
export function watchServerTrees(packageRoot: string, onChange: (file: string) => void): FSWatcher {
  const watcher = chokidar.watch(SERVER_TREES.map((tree) => path.join(packageRoot, tree)), { ignoreInitial: true });
  watcher.on('all', (_event, file) => onChange(file));
  watcher.on('error', (err) => logError('watching server/ and shared/ failed', err));
  return watcher;
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
  const read = () => {
    const roots = entriesOf(entries);
    const graph = coreImportGraphWithMissing(codeRoot, roots);
    return { files: [...graph.files, ...graph.missing].map((rel) => path.join(codeRoot, rel)), roots: new Set(roots.map((rel) => path.join(codeRoot, rel))) };
  };
  let watched = new Set(read().files);
  const watcher = chokidar.watch([...watched], { ignoreInitial: true });
  // Callers void this: a disk error re-reading the graph is logged and the files watched so far stay watched, since
  // an unhandled rejection would exit the supervisor and /__recovery with it. One at a time, each against the set the
  // one before it left: two compared with the same set would both add (and signal) the same new files.
  let queue = Promise.resolve();
  const refresh = () => (queue = queue.then(apply));
  const apply = async () => {
    try {
      const { files, roots } = read();
      const next = new Set(files);
      const added = [...next].filter((f) => !watched.has(f));
      const gone = [...watched].filter((f) => !next.has(f));
      if (gone.length) watcher.unwatch(gone);
      if (added.length) watcher.add(added);
      watched = next;
      // A new entry is a change to the caller's own listing (a new server/ or shared/ module), which the caller watches
      // and has already reloaded for: signalling it again would drain the child that reload just brought up.
      for (const f of added) if (!roots.has(f) && fs.existsSync(f)) onChange(f);
    } catch (err) {
      logError('re-reading the core import graph failed; still watching the previous files', err);
    }
  };
  watcher.on('all', (_event, file) => {
    onChange(file);
    void refresh();
  });
  watcher.on('error', (err) => logError('watching the core import graph failed', err));
  await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
  return { refresh, close: () => watcher.close() };
}

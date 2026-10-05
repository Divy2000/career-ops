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
// adds a file to watch, and only when that file exists, so over-matching is harmless.
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.\.?\/[^'"\n]+)\1/g;

/** The graph as code-root-relative paths (posix separators), sorted. */
export function coreImportGraph(codeRoot: string, entries: readonly string[]): string[] {
  const root = path.resolve(codeRoot);
  const seen = new Set<string>();
  const queue = entries.map((e) => path.join(root, e));
  while (queue.length) {
    const file = queue.shift()!;
    const rel = path.relative(root, file);
    if (seen.has(rel) || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).includes('node_modules')) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    seen.add(rel);
    for (const m of text.matchAll(IMPORT)) queue.push(path.resolve(path.dirname(file), m[2]!));
  }
  return [...seen].map((r) => r.split(path.sep).join('/')).sort();
}

export interface CoreGraphWatcher {
  /** Recompute the graph (after a reload, it may import new files) and watch what it now holds. */
  refresh(): Promise<void>;
  close(): Promise<void>;
}

/** Calls `onChange(absolutePath)` when a file of the graph changes, is added back or is removed. */
export async function watchCoreGraph(codeRoot: string, entries: readonly string[], onChange: (file: string) => void): Promise<CoreGraphWatcher> {
  const files = () => coreImportGraph(codeRoot, entries).map((rel) => path.join(codeRoot, rel));
  let watched = new Set(files());
  const watcher = chokidar.watch([...watched], { ignoreInitial: true });
  watcher.on('all', (_event, file) => onChange(file));
  await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
  return {
    async refresh() {
      const next = new Set(files());
      const added = [...next].filter((f) => !watched.has(f));
      const gone = [...watched].filter((f) => !next.has(f));
      if (gone.length) await watcher.unwatch(gone);
      if (added.length) watcher.add(added);
      watched = next;
    },
    close: () => watcher.close(),
  };
}

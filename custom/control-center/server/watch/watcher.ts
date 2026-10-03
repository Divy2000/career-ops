import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Domain, EventBus } from './bus.js';

/** Map a changed file (relative to the data root, posix separators) to the domain whose queries go stale. */
export function domainFor(relPath: string): Domain | null {
  const p = relPath.split(path.sep).join('/');
  if (p.startsWith('data/control-center/')) return null;
  if (p === 'data/applications.md' || p === 'applications.md' || p === 'data/status-log.tsv') return 'tracker';
  if (p === 'data/pipeline.md' || p === 'data/scan-history.tsv') return 'pipeline';
  if (p.startsWith('reports/')) return 'reports';
  if (p.startsWith('data/immigration/')) return 'immigration';
  if (p === 'data/follow-ups.md') return 'followups';
  if (p === 'data/shortlist.md') return 'shortlist';
  if (p === 'portals.yml' || p === 'config/profile.yml' || p === 'config/plugins.yml' || p === 'cv.md' || p === 'article-digest.md' || p === 'data/blacklist.md') return 'config';
  if (/^modes\/_[\w-]+\.md$/.test(p)) return 'config';
  return null;
}

export function startWatcher(dataRoot: string, bus: EventBus, debounceMs = 300): FSWatcher {
  const targets = ['data', 'reports', 'config', 'modes', 'portals.yml', 'cv.md', 'article-digest.md', 'applications.md'].map((t) => path.join(dataRoot, t));
  const watcher = chokidar.watch(targets, {
    ignoreInitial: true,
    ignored: (p: string) => p.includes(`${path.sep}node_modules${path.sep}`) || p.includes(`${path.sep}control-center${path.sep}`),
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  const pending = new Map<Domain, { paths: Set<string>; timer: NodeJS.Timeout }>();
  const onChange = (file: string) => {
    const rel = path.relative(dataRoot, file);
    const domain = domainFor(rel);
    if (!domain) return;
    const entry = pending.get(domain);
    if (entry) {
      entry.paths.add(rel);
      return;
    }
    const paths = new Set([rel]);
    const timer = setTimeout(() => {
      pending.delete(domain);
      bus.publish('data.changed', { domain, paths: [...paths] });
    }, debounceMs);
    pending.set(domain, { paths, timer });
  };
  watcher.on('add', onChange).on('change', onChange).on('unlink', onChange);
  return watcher;
}

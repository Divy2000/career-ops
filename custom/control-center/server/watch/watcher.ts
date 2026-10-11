import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Domain, EventBus } from './bus.js';
import { INSIGHTS_INPUT_DIRS, INSIGHTS_INPUT_FILES } from '../domains/insightsCache.js';

/** Map a changed file (relative to the data root, posix separators) to the domain whose queries go stale. */
export function domainFor(relPath: string): Domain | null {
  const p = relPath.split(path.sep).join('/');
  if (p.startsWith('data/control-center/')) return null;
  if (p === 'data/applications.md' || p === 'applications.md' || p === 'data/status-log.tsv' || p === 'status-log.tsv') return 'tracker';
  if (p === 'data/pipeline.md' || p === 'data/scan-history.tsv') return 'pipeline';
  if (p.startsWith('reports/')) return 'reports';
  // The weekly sync's logs show in the Job logs view, whose queries sit under the immigration key.
  if (p.startsWith('data/immigration/') || p.startsWith('data/upstream-sync/')) return 'immigration';
  // Interview prep, debrief and story-bank sessions write under interview-prep/; the active list has two upstream homes.
  if (p === 'data/active-interviews.md' || p === 'active-interviews.md' || p.startsWith('interview-prep/')) return 'interviews';
  // A re-render or a tailored CV writes its PDF and HTML under output/, and generate-pdf.mjs files it in the PDF index.
  if (p.startsWith('output/') || p === 'data/pdf-index.tsv') return 'documents';
  // JD captures list in an application's Documents tab and are Insights inputs.
  if (p.startsWith('jds/')) return 'jds';
  if (p === 'data/follow-ups.md' || p === 'data/contacts.tsv') return 'followups';
  if (p === 'data/shortlist.md') return 'shortlist';
  if (p === 'portals.yml' || p === 'config/profile.yml' || p === 'config/plugins.yml' || p === 'cv.md' || p === 'article-digest.md' || p === 'voice-dna.md' || p === 'data/blacklist.md') return 'config';
  if (/^modes\/_[\w-]+\.md$/.test(p)) return 'config';
  // Last, so a more specific domain above wins for a file the Insights scripts also read.
  if (INSIGHTS_INPUT_FILES.includes(p) || INSIGHTS_INPUT_DIRS.some((dir) => p.startsWith(`${dir}/`))) return 'insights';
  return null;
}

/** Top-level files and folders watched under the data root, each Insights input's top-level entry included. */
export const WATCH_TARGETS: readonly string[] = [
  ...new Set([
    ...['data', 'reports', 'config', 'modes', 'portals.yml', 'cv.md', 'article-digest.md', 'voice-dna.md', 'applications.md', 'status-log.tsv', 'interview-prep', 'active-interviews.md', 'output', 'jds'],
    ...[...INSIGHTS_INPUT_FILES, ...INSIGHTS_INPUT_DIRS].map((rel) => rel.split('/')[0]!),
  ]),
];

/**
 * `trackerPaths` are absolute spellings of the tracker path-resolver.mjs resolves (CAREER_OPS_TRACKER first): its
 * lexical path and its realpath. Each one and the status log set-status.mjs appends beside it are tracker files
 * wherever they sit, and are watched even where the data root's ignore rules would hide them.
 */
export function startWatcher(dataRoot: string, bus: EventBus, debounceMs = 300, trackerPaths: readonly string[] = []): FSWatcher {
  const targets = WATCH_TARGETS.map((t) => path.join(dataRoot, t));
  const trackerFiles = [...new Set(trackerPaths.flatMap((p) => [p, path.join(path.dirname(p), 'status-log.tsv')]))];
  // chokidar watches a missing file through its folder, so the folder must pass the ignore rules too.
  const trackerDirs = new Set(trackerFiles.map((f) => path.dirname(f)));
  const watcher = chokidar.watch([...targets, ...trackerFiles], {
    ignoreInitial: true,
    // Judged inside the data root: the root itself may sit under a folder named control-center or node_modules.
    ignored: (p: string) => {
      const relPath = path.relative(dataRoot, p);
      const rel = relPath.split(path.sep);
      // Outside the root only a tracker file is watched, or its folder while the file does not exist yet.
      if (rel[0] === '..' || path.isAbsolute(relPath) || trackerFiles.includes(p) || trackerDirs.has(p)) return false;
      return rel.includes('node_modules') || (rel[0] === 'data' && rel[1] === 'control-center');
    },
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  const pending = new Map<Domain, { paths: Set<string>; timer: NodeJS.Timeout }>();
  const onChange = (file: string) => {
    const rel = path.relative(dataRoot, file);
    const domain = trackerFiles.includes(file) ? 'tracker' : domainFor(rel);
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

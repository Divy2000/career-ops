import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { EventBus } from '../../server/watch/bus.js';
import { INSIGHTS_INPUT_DIRS, INSIGHTS_INPUT_FILES } from '../../server/domains/insightsCache.js';
import { WATCH_TARGETS, domainFor, startWatcher } from '../../server/watch/watcher.js';
import { DOMAIN_KEYS } from '../../web/lib/sse.js';
import { tempDir } from '../helpers/tmp.js';

type Published = { domain: string; paths: string[] };

/** One file per Insights input: each listed file, plus a file inside each listed folder. */
const INPUTS = [...INSIGHTS_INPUT_FILES, ...INSIGHTS_INPUT_DIRS.map((dir) => `${dir}/r21-probe.md`)];

const invalidatesInsights = (domain: string | null) => domain !== null && (DOMAIN_KEYS[domain] ?? []).some((k) => k.length === 1 && k[0] === 'insights');

describe('watcher derives its Insights inputs from insightsCache (FU-watch-01)', () => {
  it('maps every Insights input to a domain that invalidates the insights queries', () => {
    for (const rel of INPUTS) expect({ rel, refreshes: invalidatesInsights(domainFor(rel)) }).toEqual({ rel, refreshes: true });
  });

  it('keeps the inputs the Insights scripts are known to read in the shared lists', () => {
    // Pinned literally, so dropping one from insightsCache's lists fails here and not only in the Insights tab.
    const files = ['data/assessments.tsv', 'data/salary-observations.tsv', 'config/benchmarks.yml', 'data/scan-history.tsv', 'data/blacklist.md'];
    const inDirs = ['interview-prep/sessions/2026-10-05-acme.md', 'jds/007-acme.pdf', 'reports/001-acme.md'];
    for (const rel of files) expect({ rel, listed: INSIGHTS_INPUT_FILES.includes(rel), refreshes: invalidatesInsights(domainFor(rel)) }).toEqual({ rel, listed: true, refreshes: true });
    for (const rel of inDirs) expect({ rel, listed: INSIGHTS_INPUT_DIRS.includes(path.posix.dirname(rel)), refreshes: invalidatesInsights(domainFor(rel)) }).toEqual({ rel, listed: true, refreshes: true });
  });

  it('watches a target that contains every Insights input', () => {
    for (const rel of INPUTS) expect({ rel, watched: WATCH_TARGETS.some((t) => rel === t || rel.startsWith(`${t}/`)) }).toEqual({ rel, watched: true });
  });

  it('keeps the more specific domain for a file that is also an Insights input', () => {
    expect(domainFor('data/applications.md')).toBe('tracker');
    expect(domainFor('data/pipeline.md')).toBe('pipeline');
    expect(domainFor('reports/001-x.md')).toBe('reports');
    expect(domainFor('interview-prep/story-bank.md')).toBe('interviews');
    expect(domainFor('jds/x.pdf')).toBe('jds');
    expect(domainFor('data/follow-ups.md')).toBe('followups');
    expect(domainFor('cv.md')).toBe('config');
    expect(domainFor('data/assessments.tsv')).toBe('insights');
  });

  it('the real watcher refreshes the insights queries for an edit to every Insights input', async () => {
    const root = tempDir('cc-watch-');
    for (const rel of INPUTS) fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    const published: Published[] = [];
    const watcher = startWatcher(root, { publish: (_type: string, payload: Published) => void published.push(payload) } as unknown as EventBus, 20);
    const seen = (rel: string) => published.some((p) => p.paths.includes(path.normalize(rel)) && invalidatesInsights(p.domain));
    try {
      await new Promise<void>((resolve) => watcher.on('ready', () => resolve()));
      const deadline = Date.now() + 15_000;
      // FSEvents can miss a write right after 'ready', so unseen inputs are rewritten until each one is reported.
      for (let i = 0; !INPUTS.every(seen) && Date.now() < deadline; i++) {
        if (i % 10 === 0) for (const rel of INPUTS) if (!seen(rel)) fs.writeFileSync(path.join(root, rel), `row\t${i}\n`);
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await watcher.close();
    }
    for (const rel of INPUTS) expect({ rel, refreshed: seen(rel) }).toEqual({ rel, refreshed: true });
  }, 30_000);
});

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { EventBus } from '../../server/watch/bus.js';
import { startWatcher } from '../../server/watch/watcher.js';
import { DOMAIN_KEYS } from '../../web/lib/sse.js';
import { tempDir } from '../helpers/tmp.js';

type Published = { domain: string; paths: string[] };

/** Keys the web client invalidates for the event that reported `rel`, or null when no event named it. */
function keysFor(published: Published[], rel: string): string[][] | null {
  const ev = published.find((p) => p.paths.includes(rel));
  return ev ? DOMAIN_KEYS[ev.domain] ?? [] : null;
}

/** Starts the real watcher on `root`, repeats `write` until `done` holds (FSEvents can miss a write right after 'ready'), and returns what it published. */
async function watchWhile(root: string, write: (i: number) => void, done: (p: Published[]) => boolean): Promise<Published[]> {
  const published: Published[] = [];
  const watcher = startWatcher(root, { publish: (_type: string, payload: Published) => void published.push(payload) } as unknown as EventBus, 20);
  try {
    await new Promise<void>((resolve) => watcher.on('ready', () => resolve()));
    const deadline = Date.now() + 10_000;
    for (let i = 0; !done(published) && Date.now() < deadline; i++) {
      if (i % 10 === 0) write(i);
      await new Promise((r) => setTimeout(r, 50));
    }
    return published;
  } finally {
    await watcher.close();
  }
}

describe('watcher refreshes the Insights and Documents tabs (R20-weblib-L2-01)', () => {
  it('an edit to an Insights-only input refreshes the insights queries', async () => {
    const root = tempDir('cc-watch-');
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    const inputs = [path.join('data', 'assessments.tsv'), path.join('data', 'salary-observations.tsv'), path.join('config', 'benchmarks.yml')];
    const published = await watchWhile(
      root,
      (i) => inputs.forEach((rel) => fs.writeFileSync(path.join(root, rel), `row\t${i}\n`)),
      (p) => inputs.every((rel) => keysFor(p, rel) !== null),
    );
    for (const rel of inputs) expect({ rel, keys: keysFor(published, rel) }).toEqual({ rel, keys: expect.arrayContaining([['insights']]) });
  });

  it('a JD capture written under jds/ refreshes the Documents tab and the insights queries', async () => {
    const root = tempDir('cc-watch-');
    fs.mkdirSync(path.join(root, 'jds'), { recursive: true });
    const rel = path.join('jds', '007-2026-10-11_acme_engineer.pdf');
    const published = await watchWhile(root, (i) => fs.writeFileSync(path.join(root, rel), `%PDF-1.7 ${i}\n`), (p) => keysFor(p, rel) !== null);
    expect(keysFor(published, rel)).toEqual(expect.arrayContaining([['tracker', 'documents'], ['apply', 'documents'], ['insights']]));
  });
});

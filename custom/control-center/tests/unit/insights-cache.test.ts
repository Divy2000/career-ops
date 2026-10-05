import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { inputsKey } from '../../server/domains/insightsCache.js';
import { copyFixtureRoot } from '../helpers/app.js';

describe('the insights cache key', () => {
  // upskill leaves out skills cv.md already has and story provenance traces stories to cv.md and the digest.
  for (const rel of ['cv.md', 'article-digest.md']) {
    it(`changes when ${rel} is edited, so cached insights are recomputed`, () => {
      const root = copyFixtureRoot();
      const file = path.join(root, rel);
      const before = inputsKey(root);
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(file, later, later);
      expect(inputsKey(root)).not.toBe(before);
    });
  }
});

describe('the insights cache key covers every file the insights scripts read', () => {
  // assessment-log.mjs, salary-gap.mjs:39, process-quality.mjs:45 and rejection-latency.mjs:64 (data/ first, then the
  // root copy), funnel-velocity.mjs:251, detect-reposts.mjs:76.
  for (const rel of ['data/assessments.tsv', 'data/salary-observations.tsv', 'data/active-interviews.md', 'active-interviews.md', 'config/benchmarks.yml', 'portals.yml']) {
    it(`changes when ${rel} is added or edited`, () => {
      const root = copyFixtureRoot();
      const file = path.join(root, rel);
      fs.rmSync(file, { force: true });
      const before = inputsKey(root);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'x\n');
      const added = inputsKey(root);
      expect(added).not.toBe(before);
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(file, later, later);
      expect(inputsKey(root)).not.toBe(added);
    });
  }

  for (const rel of ['reports/001-acme-robotics.md', 'interview-prep/story-bank.md']) {
    it(`changes when ${rel} is edited in place (its folder's own time does not move)`, () => {
      const root = copyFixtureRoot();
      const dir = path.dirname(path.join(root, rel));
      const dirTime = fs.statSync(dir).mtime;
      const before = inputsKey(root);
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(path.join(root, rel), later, later);
      fs.utimesSync(dir, dirTime, dirTime);
      expect(inputsKey(root)).not.toBe(before);
    });
  }
});

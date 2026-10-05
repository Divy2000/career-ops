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

#!/usr/bin/env node
// Fails when any text this package writes contains U+2014. Parsed data may
// contain it (score sentinels, verdict lines), so code builds the character
// from its code point and fixture files that imitate that data are excluded.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Upstream conventions: main-module detection and nested-checkout guard come from core lib/.
import { isMainModule } from '../../../lib/is-main-module.mjs';
import { isNestedCheckout } from '../../../lib/mjs-files.mjs';

export const EM_DASH = String.fromCharCode(0x2014);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test-results', 'playwright-report', '.tmp', 'fixtures']);
const TEXT_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.json', '.md', '.css', '.html', '.yml', '.yaml', '.sh', '']);

export function findEmDashes(dir) {
  const hits = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      // A symlink (node_modules in a linked worktree, say) points at files this package did not write.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const child = path.join(d, entry.name);
        if (!SKIP_DIRS.has(entry.name) && !isNestedCheckout(child)) walk(child);
        continue;
      }
      if (!TEXT_EXT.has(path.extname(entry.name))) continue;
      const file = path.join(d, entry.name);
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (line.includes(EM_DASH)) hits.push(`${path.relative(root, file)}:${i + 1}`);
      });
    }
  };
  walk(dir);
  return hits;
}

if (isMainModule(import.meta.url)) {
  const hits = findEmDashes(root);
  if (hits.length) {
    console.error(`em dash (U+2014) found in ${hits.length} place(s):\n  ${hits.join('\n  ')}`);
    process.exit(1);
  }
  console.log('no-em-dash: ok');
}

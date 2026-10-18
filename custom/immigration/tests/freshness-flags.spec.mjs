import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';
import { spawnCpuLimited } from '../../test-support/cpu-limit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const run = (root, args) => spawnCpuLimited(process.execPath, [path.join(REPO, 'custom', 'immigration', 'freshness.mjs'), ...args], { cwd: REPO, env: { ...process.env, CAREER_OPS_ROOT: root, NO_COLOR: '1' }, encoding: 'utf8' });

function rootWithCheck() {
  const root = tempDir('imm-fresh-flags-');
  fs.mkdirSync(path.join(root, 'data', 'immigration', 'companies'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'immigration', 'companies', 'acme-robotics.md'), '---\nchecked_at: 2026-10-16\n---\n');
  return root;
}

for (const args of [['--today=2026-10-17', 'Acme Robotics'], ['--today', '2026-10-17', 'Acme Robotics'], ['Acme Robotics', '--today=2026-10-17']]) {
  test(`given a saved check, when the date is passed as ${args.join(' ')}, then that company is checked for that day`, () => {
    const r = run(rootWithCheck(), args);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.company, 'Acme Robotics');
    assert.equal(out.slug, 'acme-robotics');
    assert.equal(out.checked_at, '2026-10-16');
    assert.equal(out.refresh, false);
  });
}

for (const args of [['--json', 'Acme Robotics'], ['Acme Robotics', 'Other Co'], ['--today'], ['--today', '2026-10-17'], ['--today=17-10-2026', 'Acme Robotics'], ['--today', 'Acme Robotics']]) {
  test(`given bad arguments ${JSON.stringify(args)}, then it fails without a decision`, () => {
    const r = run(rootWithCheck(), args);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout.trim().startsWith('{'), false, r.stdout);
  });
}

test('given --help, then it prints usage and exits 0', () => {
  const r = run(rootWithCheck(), ['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /freshness\.mjs/);
});

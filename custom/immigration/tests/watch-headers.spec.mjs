import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';
import { spawnCpuLimited } from '../../test-support/cpu-limit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WATCH = path.join(REPO, 'custom', 'immigration', 'watch.mjs');
const FILES = {
  'policy-changes.tsv': 'detected_date\tannounced_date\tsource\ttitle\turl\timpact\n2026-10-11\t2026-10-10\tuscis\tH-1B rule\thttps://www.uscis.gov/news/x\tfee change\n',
  'company-alerts.tsv': 'date\tcompany\tslug\tstatus\theadline\turl\n2026-10-11\tAcme\tacme\tpaused\tAcme pauses sponsorship\thttps://news.example/acme\n',
};

// Both sources answer with nothing. `stale` makes watch.mjs observe the two policy-pass files as missing although they
// exist: the view of a run that checked before a concurrent run created the file and a policy pass appended to it.
function runWatch(root, { stale }) {
  const preload = path.join(root, 'preload.mjs');
  const lie = stale
    ? `const real = fs.existsSync;\nfs.existsSync = (p) => (/(policy-changes|company-alerts)\\.tsv$/.test(String(p)) ? false : real(p));\nsyncBuiltinESMExports();\n`
    : '';
  fs.writeFileSync(
    preload,
    `import fs from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\n${lie}globalThis.fetch = async (url) => (String(url).includes('federalregister') ? new Response(JSON.stringify({ results: [] }), { status: 200 }) : new Response('<rss><channel></channel></rss>', { status: 200 }));\n`,
  );
  const r = spawnCpuLimited(process.execPath, ['--import', preload, WATCH], { cwd: REPO, env: { PATH: process.env.PATH, HOME: root, CAREER_OPS_ROOT: root, NO_COLOR: '1' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

test('a run that saw the policy-pass files missing never truncates the entries written since (R23-scripts-a-X-02)', () => {
  const root = tempDir('imm-headers-');
  const imm = path.join(root, 'data', 'immigration');
  fs.mkdirSync(imm, { recursive: true });
  for (const [name, text] of Object.entries(FILES)) fs.writeFileSync(path.join(imm, name), text);
  runWatch(root, { stale: true });
  for (const [name, text] of Object.entries(FILES)) assert.equal(fs.readFileSync(path.join(imm, name), 'utf8'), text, name);
});

test('a fresh data root gets both policy-pass files created with their headers (R23-scripts-a-X-02)', () => {
  const root = tempDir('imm-headers-');
  runWatch(root, { stale: false });
  const imm = path.join(root, 'data', 'immigration');
  for (const [name, text] of Object.entries(FILES)) assert.equal(fs.readFileSync(path.join(imm, name), 'utf8'), text.split('\n')[0] + '\n', name);
});

test('a policy-pass file that is a symlink to a not-yet-created file gets its target created with the header (R23-scripts-a-X-02)', () => {
  const root = tempDir('imm-headers-');
  const imm = path.join(root, 'data', 'immigration');
  fs.mkdirSync(imm, { recursive: true });
  fs.mkdirSync(path.join(root, 'elsewhere'));
  for (const name of Object.keys(FILES)) fs.symlinkSync(path.join('..', '..', 'elsewhere', name), path.join(imm, name));
  runWatch(root, { stale: false });
  for (const [name, text] of Object.entries(FILES)) assert.equal(fs.readFileSync(path.join(root, 'elsewhere', name), 'utf8'), text.split('\n')[0] + '\n', name);
});

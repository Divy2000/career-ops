// What every install*.spec.mjs shares: one world per test, the quiet flags, and small file helpers. The installer
// specs are split across files only so node --test runs them in parallel processes; each test builds its own world.
import fs from 'node:fs';
import path from 'node:path';
import { makeWorld, INSTALL_DIR, pythonPtyMissing, SYSTEM_DIRS } from './harness.mjs';

export const SECRET = 'FAKE-SECRET-123';
export const QUIET = ['--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'none'];
// pty_run.py needs a python3 that runs; without one the pty tests skip instead of failing. pty_run.py's own tests
// find it on this process's PATH, an install run under a pty on the world's system folders.
export const PTY_SKIP = pythonPtyMissing(process.env.PATH);
export const WORLD_PTY_SKIP = pythonPtyMissing(SYSTEM_DIRS.join(':'));

export function fresh(opts = {}) {
  const w = makeWorld(opts);
  const D = path.join(w.T, 'checkout');
  const args = (...extra) => ['--dir', D, '--non-interactive', ...QUIET, ...extra];
  return { w, D, args };
}
export const READY_FILES = {
  'cv.md': '# Me\n',
  'config/profile.yml': 'name: x\n',
  'modes/_profile.md': 'mine\n',
  // Seeded from its template otherwise, which the doctor reports as not personalized.
  'modes/_brief.md': 'my brief\n',
  'portals.yml': 'x: 1\n',
};
export const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
// The harness's index installer always writes the default index; this one downloads where the real plugin does (a
// trimmed H1B_INDEX_PATH taken from its working directory, else the default) or, with fail, exits 1 writing nothing,
// so a run can reach the daily job with the default index still missing.
export function h1bInstaller(D, { fail = false } = {}) {
  fs.writeFileSync(path.join(D, 'plugins/h1b-sponsor/install-h1b-index.mjs'), `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
fs.appendFileSync(process.env.STUB_LOG, 'h1b-install ' + process.argv.slice(2).join(' ') + '\\n');
if (${fail}) process.exit(1);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const set = (process.env.H1B_INDEX_PATH || '').trim();
const idx = set ? path.resolve(set) : path.join(root, 'data', 'h1b', 'index.ndjson.gz');
fs.mkdirSync(path.dirname(idx), { recursive: true });
fs.writeFileSync(idx, 'x');
`);
}
export const exists = (...p) => fs.existsSync(path.join(...p));
export const md = (w, name, data) => w.write(`src/${name}`, data);
// A freshly seeded modes/_custom.md: the template with the projects-library rule in place of its first "none yet" line.
export const seededCustom = () => read(INSTALL_DIR, 'templates', '_custom.md').replace('(none yet -- add yours above)', read(INSTALL_DIR, 'templates', '_custom-projects.md').trimEnd());

/** A cpSync filter for a copy of `root` (custom/install) without its tests/ folder, wherever the checkout lives. */
export const withoutTests = (root) => (src) => path.relative(root, src).split(path.sep)[0] !== 'tests';

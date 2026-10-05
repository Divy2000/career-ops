// Audit plugins: plugin-audit.mjs scans ONE plugin directory (no argument is a usage error), so this runs its own
// auditPlugin over every community plugin in the plugins.local/ folder it is given. Bundled plugins in plugins/ are
// reviewed in-tree and are not subject to the scan (plugin-audit.mjs header). Exit 1 when any plugin has findings.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Loaded by URL: plugin-audit.mjs is @ts-check upstream code, and a static import would pull it into this package's typecheck.
const { auditPlugin } = await import(new URL('../../../../plugin-audit.mjs', import.meta.url).href);

const [dir, ...extra] = process.argv.slice(2);
if (!dir || extra.length) {
  console.error('Usage: node plugin-audit-all.mjs <plugins.local dir>');
  process.exit(2);
}

let names = [];
try {
  names = readdirSync(dir).filter((n) => !n.startsWith('.') && !n.startsWith('_'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
// plugins.local/<id> may be a symlink to a plugin checkout, so follow links when deciding what is a directory.
const plugins = names.filter((n) => statSync(path.join(dir, n), { throwIfNoEntry: false })?.isDirectory()).sort();
if (plugins.length === 0) {
  console.log('No community plugins in plugins.local/ to audit. Bundled plugins in plugins/ are reviewed in-tree.');
  process.exit(0);
}

let flagged = 0;
for (const id of plugins) {
  const { ok, findings } = auditPlugin(path.join(dir, id));
  if (ok) {
    console.log(`✓ ${id}: audit clean`);
    continue;
  }
  flagged += 1;
  for (const f of findings) console.log(`✗ ${id}/${f.file}: ${f.issue}`);
}
console.log(`${plugins.length} community plugin${plugins.length === 1 ? '' : 's'} audited, ${flagged} with findings.`);
process.exit(flagged ? 1 : 0);

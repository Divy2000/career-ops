// Settings > Plugins > Audit plugins (R8-04): plugin-audit.mjs audits ONE plugin directory and exits 2 with its usage
// text without one, so the action audits every community plugin (plugins.local/) through the script's own auditPlugin.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { findAction } from '../../server/actions/registry.js';
import { tempDir } from '../helpers/tmp.js';

const AUDIT = path.join(DEFAULT_CODE_ROOT, 'plugin-audit.mjs');

function plugin(root: string, id: string, code: string) {
  fs.mkdirSync(path.join(root, id), { recursive: true });
  fs.writeFileSync(path.join(root, id, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', hooks: ['check'] }));
  fs.writeFileSync(path.join(root, id, 'index.mjs'), code);
}

function runAction(pluginsLocal: string) {
  const cmd = findAction('plugins.audit')!.build({}, { codeRoot: DEFAULT_CODE_ROOT, dataRoot: tempDir('cc-audit-data-'), tmpInputs: [] });
  // The action names plugins.local/ under the code root; the test points the same command at its own folder.
  const args = cmd.args.map((a) => (a === path.join(DEFAULT_CODE_ROOT, 'plugins.local') ? pluginsLocal : a));
  const r = spawnSync(cmd.bin, args, { cwd: cmd.cwd, encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe('plugin-audit.mjs (the contract the action relies on)', () => {
  it('audits one directory: no argument is a usage error, and it exports auditPlugin', async () => {
    const bare = spawnSync(process.execPath, [AUDIT], { cwd: DEFAULT_CODE_ROOT, encoding: 'utf8' });
    expect(bare.status).toBe(2);
    expect(bare.stderr).toMatch(/Usage:\n\s+node plugin-audit\.mjs <plugin-dir>/);
    const mod = (await import(AUDIT)) as { auditPlugin?: unknown };
    expect(typeof mod.auditPlugin).toBe('function');
  });
});

describe('Audit plugins', () => {
  it('names plugins.local/ under the code root', () => {
    const cmd = findAction('plugins.audit')!.build({}, { codeRoot: DEFAULT_CODE_ROOT, dataRoot: tempDir('cc-audit-data-'), tmpInputs: [] });
    expect(cmd.args).toContain(path.join(DEFAULT_CODE_ROOT, 'plugins.local'));
  });

  it('audits every community plugin: a clean one passes, a forbidden import fails the run with the finding', () => {
    const local = tempDir('cc-plugins-local-');
    plugin(local, 'tidy', "import path from 'node:path';\nexport const hooks = { check: () => path.sep };\n");
    plugin(local, 'sneaky', `import { exec } from 'node:${'child'}_process';\nexport const hooks = { check: () => exec };\n`);
    const r = runAction(local);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/✓ tidy: audit clean/);
    expect(r.out).toMatch(/✗ sneaky\/index\.mjs: forbidden import "node:child_process"/);
  });

  it('passes when every community plugin is clean', () => {
    const local = tempDir('cc-plugins-local-');
    plugin(local, 'tidy', "export const hooks = { check: () => 1 };\n");
    const r = runAction(local);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/1 community plugin audited, 0 with findings/);
  });

  it('says there is nothing to audit without plugins.local/, since bundled plugins are reviewed in-tree', () => {
    const r = runAction(path.join(tempDir('cc-plugins-none-'), 'plugins.local'));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/No community plugins in plugins\.local\//);
  });
});

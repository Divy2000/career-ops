import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { READ_DENY } from '../../server/claude/modes.js';
import { narrowGrepInput } from '../../server/claude/guard-policy.mjs';
import { tempDir } from '../helpers/tmp.js';

const RG_INSTALLED = spawnSync('rg', ['--version']).status === 0;
if (!RG_INSTALLED) console.warn('grep-narrowing-rg.test.ts skipped: ripgrep (rg) is not installed, so the Grep narrowing cannot be run against the real rg');

/**
 * How Claude Code turns a Grep `glob` into `rg --glob` arguments: split on whitespace, then split each piece on commas
 * unless the piece has braces (a brace alternative keeps its commas).
 */
function claudeCodeGlobArgs(glob: string): string[] {
  const pieces = glob.split(/\s+/).filter(Boolean).flatMap((p) => (p.includes('{') ? [p] : p.split(',').filter(Boolean)));
  return pieces.flatMap((p) => ['--glob', p]);
}

/**
 * Files whose contents a narrowed Grep for SECRET returns, relative to root, with the search path given absolute and
 * as `.` from the root (rg matches globs against the path as given). --hidden --no-ignore leaves the excludes as the
 * only protection. Both shapes must agree.
 */
function grepFiles(root: string, callerGlob?: string): string[] {
  const input = narrowGrepInput(callerGlob === undefined ? { pattern: 'SECRET', path: root } : { pattern: 'SECRET', path: root, glob: callerGlob }, READ_DENY);
  const run = (searchPath: string) => {
    const r = spawnSync('rg', ['--hidden', '--no-ignore', '--files-with-matches', ...claudeCodeGlobArgs(input.glob), '--', 'SECRET', searchPath], { cwd: root, encoding: 'utf8' });
    expect(r.status === 0 || r.status === 1, r.stderr).toBe(true);
    return r.stdout.split('\n').filter(Boolean).map((f) => path.relative(root, path.resolve(root, f))).sort();
  };
  const absolute = run(root);
  expect(run('.'), `glob ${callerGlob}`).toEqual(absolute);
  return absolute;
}

describe.skipIf(!RG_INSTALLED)('a narrowed Grep run through the real rg (R18-tests-cc-L1-01)', () => {
  const root = fs.realpathSync(tempDir('cc-grep-narrow-'));
  const secrets = ['.env', 'upper/.ENV', 'sub/.env.local', 'server.pem', 'id_rsa', 'id_rsa_old', '.git/config', 'credentials-prod.json', 'keys/.Env'];
  for (const rel of [...secrets, 'notes.md', 'src/app.tsx']) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), 'SECRET=1\n');
  }

  it('returns no secret file for a Grep with no glob, or with a caller glob that spells one through wildcards, escapes, classes or braces', () => {
    for (const glob of [undefined, '*', '**/*', '.\\env', '**/\\.env', '.e?v.local', 'server.p[e]m', '{x,{.env,y}}', 'id_rs[a]_old', '**/credentials-prod.js[o]n', '.git[/]config', '*.md,.env', '*.md .env']) {
      const found = grepFiles(root, glob);
      for (const rel of secrets) expect(found, `glob ${glob}`).not.toContain(rel);
    }
    expect(grepFiles(root)).toEqual(['notes.md', 'src/app.tsx']);
    expect(grepFiles(root, '*')).toEqual(['notes.md', 'src/app.tsx']);
  });

  it('still returns the files a caller glob asks for', () => {
    expect(grepFiles(root, '*.md')).toEqual(['notes.md']);
    expect(grepFiles(root, '*.tsx')).toEqual(['src/app.tsx']);
    // A caller brace glob stays its own piece, so the excludes after it never fold into its alternatives.
    expect(grepFiles(root, '*.{md,tsx}')).toEqual(['notes.md', 'src/app.tsx']);
  });
});

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

/** Files that may spell colors out: the token definitions and the pre-paint boot script. */
const EXEMPT = new Set(['styles/tokens.css', 'public/theme-boot.js']);
/** Color-looking data that is not styling. Each entry names the literal and why it stays. */
const DATA_LITERALS: Record<string, string[]> = {
  // Default written into profile.yml for the CV PDF accent; it is the user's data, not app chrome.
  'features/settings/ProfileForm.tsx': ['#2563eb'],
};

const COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (/\.(ts|tsx|css|html|js)$/.test(e.name)) out.push(abs);
  }
  return out;
}

/** Every surface is themed through the tokens, so a literal color is a theme that cannot switch. */
describe('web/ spells colors only in tokens.css and the boot script', () => {
  it('has no hex, rgb(), hsl() or other color literals in components or stylesheets', () => {
    const offenders: string[] = [];
    for (const file of walk(WEB)) {
      const rel = path.relative(WEB, file).split(path.sep).join('/');
      if (EXEMPT.has(rel)) continue;
      const allowed = DATA_LITERALS[rel] ?? [];
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
        const hits = (line.match(COLOR) ?? []).filter((h) => !allowed.includes(h));
        if (hits.length) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the data-literal allowlist honest: each entry still occurs in its file', () => {
    for (const [rel, literals] of Object.entries(DATA_LITERALS)) {
      const text = fs.readFileSync(path.join(WEB, rel), 'utf8');
      for (const l of literals) expect(text, `${rel} no longer contains ${l}`).toContain(l);
    }
  });
});

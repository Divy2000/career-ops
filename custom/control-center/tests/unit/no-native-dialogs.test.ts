import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(abs);
  }
  return out;
}

// Destructive confirms use the Radix ConfirmDialog, feedback uses sonner toasts (spec P6).
describe('web/ never uses the native browser dialogs', () => {
  it('has no window.confirm, window.alert, window.prompt or bare confirm()/alert() calls', () => {
    const offenders: string[] = [];
    const files = walk(WEB);
    // Plain scripts served as they are (the theme boot) can call the dialogs too.
    expect(files).toContain(path.join(WEB, 'public', 'theme-boot.js'));
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
        if (/\bwindow\.(confirm|alert|prompt)\(/.test(line) || /(^|[^.\w])(confirm|alert|prompt)\(/.test(line.replace(/\bawait confirm\(|\bconfirm = useConfirm\(/g, ''))) {
          offenders.push(`${path.relative(WEB, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

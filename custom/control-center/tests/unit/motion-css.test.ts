import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const motion = fs.readFileSync(path.join(WEB, 'styles', 'motion.css'), 'utf8');
const main = fs.readFileSync(path.join(WEB, 'main.tsx'), 'utf8');

/** The body of an at-rule block, found by brace matching. */
function atRule(css: string, header: RegExp): string {
  const m = header.exec(css);
  if (!m) return '';
  let depth = 0;
  for (let i = css.indexOf('{', m.index); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', m.index) + 1, i);
  }
  return '';
}

describe('motion.css', () => {
  it('is imported last so its transitions win over the component styles', () => {
    const imports = [...main.matchAll(/import '\.\/styles\/([\w-]+)\.css'/g)].map((m) => m[1]);
    expect(imports.at(-1)).toBe('motion');
  });

  it('zeroes every duration token under prefers-reduced-motion', () => {
    const reduced = atRule(motion, /@media \(prefers-reduced-motion: reduce\)/);
    for (const token of ['--dur-1', '--dur-2', '--dur-3', '--dur-4', '--dur-theme']) expect(reduced, token).toMatch(new RegExp(`${token}:\\s*0ms`));
  });

  it('keeps the spring easing behind an @supports guard so older engines fall back to a cubic-bezier', () => {
    expect(motion).toMatch(/@supports \(transition-timing-function: linear\(0, 1\)\)/);
  });

  it('never animates an exit: dialogs, the palette and drawers only animate in (an exit would race the Shell focus restore)', () => {
    expect(motion).not.toMatch(/data-state=['"]?closed/);
    expect(motion).not.toMatch(/data-state=['"]?open['"]?\][^{]*\{[^}]*animation[^}]*(reverse|forwards)/);
  });

  it('never transitions "all", which would animate layout properties and fight the focus and layout invariants', () => {
    expect(motion).not.toMatch(/transition:\s*all\b/);
    expect(motion).not.toMatch(/transition-property:\s*all\b/);
  });

  it('keeps the page-enter fill backwards so no transform (a containing block for fixed children) is left behind', () => {
    const page = /\.shell__main > section\s*\{[^}]*\}/.exec(motion)?.[0] ?? '';
    expect(page).toMatch(/animation:[^;]*backwards/);
  });

  it('turns the view-transition crossfade off so only the circular reveal is visible', () => {
    const block = /::view-transition-old\(root\),\s*::view-transition-new\(root\)\s*\{[^}]*\}/.exec(motion)?.[0] ?? '';
    expect(block).toMatch(/animation:\s*none/);
  });

  it('transitions colors during an OS-driven or fallback theme fade, scoped to the theme-fading class', () => {
    expect(motion).toMatch(/\.theme-fading,?\s*\.theme-fading \*/);
    expect(motion).toMatch(/transition:[^;]*background-color[^;]*200ms/);
  });

  it('leaves a static skeleton under reduced motion', () => {
    const reduced = atRule(motion, /@media \(prefers-reduced-motion: reduce\)/);
    expect(reduced).toMatch(/\.skeleton__line/);
    expect(reduced).toMatch(/background-image:\s*none/);
  });
});

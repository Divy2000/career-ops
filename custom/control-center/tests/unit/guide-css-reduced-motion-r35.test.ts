// Under prefers-reduced-motion the duration tokens drop to 0ms (motion.css) and base.css kills animation on `*`, but
// neither reaches an animation whose duration is a literal on a ::before or ::after: `*` does not match
// pseudo-elements. The guide's image-loading shimmer was one (R35-weblib-X-01), so guide.css turns each such
// animation off itself.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const guide = fs.readFileSync(path.join(WEB, 'styles', 'guide.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The bodies of every @media (prefers-reduced-motion: reduce) block, found by brace matching. */
function reducedBlocks(css: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{/g)) {
    let depth = 0;
    const start = m.index + m[0].length - 1;
    for (let i = start; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) {
        out.push(css.slice(start + 1, i));
        break;
      }
    }
  }
  return out.join('\n');
}

/** Top-level rules (selector, body) outside any at-rule. */
function topRules(css: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  let depth = 0;
  let from = 0;
  let selector = '';
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') {
      if (depth === 0) {
        selector = css.slice(from, i).trim();
        from = i + 1;
      }
      depth++;
    } else if (css[i] === '}' && --depth === 0) {
      if (!selector.startsWith('@')) rules.push({ selector, body: css.slice(from, i) });
      from = i + 1;
    }
  }
  return rules;
}

const untokenedPseudoAnimations = topRules(guide).filter((r) => /::?(before|after)\b/.test(r.selector) && /animation:\s*(?!none)[^;]*\b\d+(\.\d+)?m?s\b/.test(r.body.replace(/var\([^)]*\)/g, '')));

describe('guide.css under prefers-reduced-motion', () => {
  it('has the image-loading shimmer among the animations the global kill rule cannot reach', () => {
    expect(untokenedPseudoAnimations.map((r) => r.selector)).toContain(".doc-media__frame[data-ready='false']::before");
  });

  it('turns off every pseudo-element animation with a literal duration', () => {
    const reduced = reducedBlocks(guide);
    const off = topRules(reduced).filter((r) => /animation:\s*none/.test(r.body)).flatMap((r) => r.selector.split(',').map((s) => s.trim()));
    for (const r of untokenedPseudoAnimations) for (const sel of r.selector.split(',').map((s) => s.trim())) expect(off, sel).toContain(sel);
  });
});

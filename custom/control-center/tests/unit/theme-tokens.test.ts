import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKENS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'styles', 'tokens.css');
const css = fs.readFileSync(TOKENS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Top-level rule bodies by selector; tokens.css has no nesting and no at-rules around its theme blocks. */
function blocks(): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.trim().replace(/\s+/g, ' ');
    const decls = new Map<string, string>();
    for (const d of m[2]!.split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
    out.set(selector, decls);
  }
  return out;
}

const ALL = blocks();
const DARK = ALL.get(":root, [data-theme='dark']");
const LIGHT = ALL.get("[data-theme='light']");

type Rgb = [number, number, number];

function parse(value: string, theme: Map<string, string>): { rgb: Rgb; alpha: number } {
  const v = value.trim();
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) return parse(theme.get(ref[1]!) ?? '', theme);
  const hex = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb, alpha: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  const fn = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
  if (fn) return { rgb: [Number(fn[1]), Number(fn[2]), Number(fn[3])], alpha: fn[4] === undefined ? 1 : Number(fn[4]) };
  throw new Error(`cannot parse color "${value}"`);
}

const over = (top: { rgb: Rgb; alpha: number }, under: Rgb): Rgb => top.rgb.map((c, i) => Math.round(c * top.alpha + under[i]! * (1 - top.alpha))) as Rgb;

function luminance([r, g, b]: Rgb): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The opaque color of a token; translucent tokens are composited over `under`. */
const solid = (theme: Map<string, string>, token: string, under?: Rgb): Rgb => {
  const c = parse(theme.get(token) ?? '', theme);
  return c.alpha === 1 ? c.rgb : over(c, under ?? solid(theme, '--surface-1'));
};
/** Mirrors the chip rule in base.css: color-mix(in srgb, tone 14%, var(--surface-1)). */
const chipFill = (theme: Map<string, string>, tone: string): Rgb => {
  const t = solid(theme, tone);
  const base = solid(theme, '--surface-1');
  return t.map((c, i) => Math.round(c * 0.14 + base[i]! * 0.86)) as Rgb;
};

const SEMANTIC = [
  '--chrome', '--surface-overlay', '--media-stage', '--on-danger', '--border-input', '--accent-hover', '--accent-2', '--brand-gradient',
  '--accent-soft', '--success-soft', '--warning-soft', '--danger-soft', '--info-soft', '--focus-halo',
  '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--chart-track',
  '--code-bg', '--code-border', '--scrim', '--overlay', '--osd-bg', '--osd-fg', '--selection',
  '--shadow-1', '--shadow-2', '--shadow-popover', '--shadow-dialog', '--inner-highlight', '--skeleton-base', '--skeleton-shine',
  '--input-bg', '--button-bg', '--button-bg-hover', '--button-border', '--row-hover', '--nav-active-fg', '--canvas-glow', '--brand-glow', '--lift',
];

const THEMES: Array<['dark' | 'light', Map<string, string>]> = [];
if (DARK) THEMES.push(['dark', DARK]);
if (LIGHT) THEMES.push(['light', LIGHT]);

describe('theme tokens: structure', () => {
  it('declares shared scales, a dark theme (the default) and a light theme', () => {
    expect(ALL.get(':root')?.has('--space-4')).toBe(true);
    expect(DARK, 'dark block ":root, [data-theme=\'dark\']"').toBeDefined();
    expect(LIGHT, 'light block "[data-theme=\'light\']"').toBeDefined();
  });

  it('keeps theme-independent scales out of the theme blocks', () => {
    for (const [, t] of THEMES) for (const scale of ['--space-4', '--fs-14', '--radius-md', '--font-sans']) expect(t.has(scale)).toBe(false);
  });

  it('gives every dark token a light value and vice versa', () => {
    const dark = [...(DARK?.keys() ?? [])].sort();
    const light = [...(LIGHT?.keys() ?? [])].sort();
    expect(light).toEqual(dark);
  });

  it('sets color-scheme per theme so native controls and scrollbars follow it', () => {
    expect(DARK?.get('color-scheme')).toBe('dark');
    expect(LIGHT?.get('color-scheme')).toBe('light');
  });

  it('defines every semantic token the components consume', () => {
    for (const [name, t] of THEMES) for (const token of SEMANTIC) expect(t.has(token), `${name} ${token}`).toBe(true);
  });

  it('defines the motion scale in :root: five durations and three easings', () => {
    const root = ALL.get(':root');
    for (const token of ['--dur-1', '--dur-2', '--dur-3', '--dur-4', '--dur-theme', '--ease-out', '--ease-in-out', '--ease-spring']) expect(root?.has(token), token).toBe(true);
    expect(root?.get('--dur-theme')).toBe('520ms');
    expect(root?.get('--ease-out')).toBe('cubic-bezier(0.2, 0.8, 0.2, 1)');
  });

  it('defines the radius scale the dialog and palette rules rely on', () => {
    for (const token of ['--radius-6', '--radius-14']) expect(ALL.get(':root')?.has(token), token).toBe(true);
  });
});

describe.each(THEMES)('theme tokens: %s contrast', (_name, t) => {
  const surfaces = ['--bg', '--surface-1', '--surface-2', '--surface-3'];
  const check = (fg: Rgb, bg: Rgb, min: number, label: string) => expect(ratio(fg, bg), label).toBeGreaterThanOrEqual(min);

  it('body text, muted text and faint text clear 4.5:1 on every surface', () => {
    for (const fg of ['--text', '--text-muted', '--text-faint']) for (const bg of surfaces) check(solid(t, fg), solid(t, bg), 4.5, `${fg} on ${bg}`);
  });

  it('the accent reads as text on the canvas and cards, and its label clears 4.5:1 on it', () => {
    for (const bg of ['--bg', '--surface-1', '--surface-2']) check(solid(t, '--accent'), solid(t, bg), 4.5, `--accent on ${bg}`);
    check(solid(t, '--accent-fg'), solid(t, '--accent'), 4.5, 'accent-fg on accent');
    check(solid(t, '--accent-fg'), solid(t, '--accent-hover'), 4.5, 'accent-fg on accent-hover');
    check(solid(t, '--on-danger'), solid(t, '--danger'), 4.5, 'on-danger on danger');
  });

  it('tone text clears 4.5:1 on its own chip fill and on plain surfaces', () => {
    for (const tone of ['--accent', '--success', '--warning', '--danger', '--info']) {
      check(solid(t, tone), chipFill(t, tone), 4.5, `${tone} on its chip`);
      for (const bg of ['--bg', '--surface-1', '--surface-2']) check(solid(t, tone), solid(t, bg), 4.5, `${tone} on ${bg}`);
    }
  });

  it('form control borders clear 3:1 against the surfaces they sit on (WCAG 1.4.11)', () => {
    for (const bg of ['--bg', '--surface-1', '--surface-2', '--input-bg']) check(solid(t, '--border-input'), solid(t, bg), 3, `--border-input on ${bg}`);
  });

  it('text clears 4.5:1 inside inputs, code blocks and hovered rows, and the active nav label stays readable', () => {
    for (const bg of ['--input-bg', '--code-bg', '--row-hover']) check(solid(t, '--text'), solid(t, bg), 4.5, `--text on ${bg}`);
    check(solid(t, '--text-faint'), solid(t, '--input-bg'), 4.5, 'placeholder (--text-faint) on --input-bg');
    check(solid(t, '--nav-active-fg'), over(parse(t.get('--accent-soft')!, t), solid(t, '--chrome')), 4.5, '--nav-active-fg on the active nav fill');
  });

  it('status dots, chart series and the focus ring clear 3:1 on cards', () => {
    const dots = [...t.keys()].filter((k) => k.startsWith('--status-'));
    expect(dots.length).toBe(9);
    for (const token of [...dots, '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--accent']) check(solid(t, token), solid(t, '--surface-1'), 3, `${token} on --surface-1`);
  });

  it('the video overlay text clears 4.5:1 on its pill over the media stage', () => {
    const stage = solid(t, '--media-stage');
    check(solid(t, '--osd-fg'), over(parse(t.get('--osd-bg')!, t), stage), 4.5, 'osd-fg on osd-bg');
  });
});

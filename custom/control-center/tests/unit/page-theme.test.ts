import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_THEME_CSS } from '../../supervisor/page-theme.js';
import { PAGE_THEME_CSS as SHARED_PAGE_THEME_CSS } from '../../shared/page-theme.js';

const TOKENS = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'styles', 'tokens.css'), 'utf8');

const decls = (body: string) => Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;}]+)/g)].map((m) => [m[1]!, m[2]!.trim().toLowerCase()]));
function tokenBlock(selector: string): Record<string, string> {
  const start = TOKENS.indexOf(selector);
  return decls(TOKENS.slice(TOKENS.indexOf('{', start) + 1, TOKENS.indexOf('}', start)));
}

describe('the static pages (locked page, recovery page) share one theme sheet', () => {
  const light = /@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(PAGE_THEME_CSS)?.[1] ?? '';
  const dark = /^\s*:root\s*\{([^}]*)\}/.exec(PAGE_THEME_CSS)?.[1] ?? '';

  it('is dark by default, switches to light with the system, and tells the browser both are supported', () => {
    expect(dark).toContain('color-scheme:dark light');
    expect(light).not.toBe('');
    expect(decls(dark)['--bg']).toBeDefined();
  });

  it.each([
    ['dark', () => decls(dark), () => tokenBlock(":root,\n[data-theme='dark']")],
    ['light', () => decls(light), () => tokenBlock("[data-theme='light'] {")],
  ])('uses the app\'s own %s token values, so the pages cannot drift from the app', (_name, page, tokens) => {
    const shared = page();
    const reference = tokens();
    const names = Object.keys(shared).filter((k) => k !== 'color-scheme');
    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const name of names) expect(shared[name], name).toBe(reference[name]);
  });

  it('the server\'s locked page uses the same sheet the supervisor owns', () => {
    expect(SHARED_PAGE_THEME_CSS).toBe(PAGE_THEME_CSS);
  });
});

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NODE_FLOOR } from '../../supervisor/preflight.js';
import { CONTRACT } from '../../server/core/adapter.js';
import { DEFAULT_CODE_ROOT, PACKAGE_ROOT } from '../../server/config.js';

type Version = [number, number, number];

const parse = (v: string): Version => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`not a full version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const cmp = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * One comparator of an npm engines range as [lowest, below) (below null: no upper bound): >=X, >X, <X, <=X, ^X, ~X, a
 * bare or x-version (18, 13.7, 10.x). Anything else throws, so a range this cannot read fails the test instead of passing.
 */
function comparator(text: string): { lowest: Version; below: Version | null; above?: true } {
  const m = /^(>=|>|<=|<|\^|~)?\s*v?(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?$/.exec(text.trim());
  if (!m) throw new Error(`unreadable engines comparator: ${JSON.stringify(text)}`);
  const [, op = '', maj, min, pat] = m;
  const parts = [maj, min, pat].map((p) => (p === undefined || p === 'x' ? null : Number(p)));
  const known = parts.filter((p) => p !== null).length;
  const v: Version = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  const next = (i: number): Version => (i === 0 ? [v[0] + 1, 0, 0] : i === 1 ? [v[0], v[1] + 1, 0] : [v[0], v[1], v[2] + 1]);
  switch (op) {
    case '>=':
      return { lowest: v, below: null };
    case '>':
      return { lowest: known === 3 ? next(2) : next(known - 1), below: null };
    case '<':
      return { lowest: [0, 0, 0], below: v };
    case '<=':
      return { lowest: [0, 0, 0], below: known === 3 ? next(2) : next(known - 1) };
    case '^':
      return { lowest: v, below: v[0] > 0 ? next(0) : v[1] > 0 ? next(1) : next(2) };
    case '~':
      return { lowest: v, below: known >= 2 ? next(1) : next(0) };
    default:
      return { lowest: v, below: next(known - 1) };
  }
}

/** The alternatives of a range: each a set of comparators that must all hold. */
const alternatives = (range: string) =>
  range.split('||').map((alt) => {
    const words = alt.trim().replace(/(>=|<=|>|<|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    if (words.length === 0) throw new Error(`empty engines alternative in ${JSON.stringify(range)}`);
    return words.map(comparator);
  });

function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  return alternatives(range).some((all) => all.every((c) => cmp(v, c.lowest) >= 0 && (c.below === null || cmp(v, c.below) < 0)));
}

/** Every dependency's engines.node in the lockfile (the package's own entry, which states the floor, left out). */
function lockfileRanges(): string[] {
  const lock = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, { engines?: { node?: string } }> };
  return Object.entries(lock.packages)
    .filter(([key, pkg]) => key !== '' && typeof pkg.engines?.node === 'string')
    .map(([, pkg]) => pkg.engines!.node!);
}

/** The lowest Node every range accepts: always one of the ranges' own lower bounds. */
function lowestAcceptedByAll(ranges: string[]): string {
  const candidates = ranges.flatMap((r) => alternatives(r).flatMap((all) => all.map((c) => c.lowest))).sort(cmp);
  const found = candidates.find((v) => ranges.every((r) => satisfies(v.join('.'), r)));
  if (!found) throw new Error('no Node version satisfies every engines range in the lockfile');
  return found.join('.');
}

describe('the Node floor', () => {
  it('reads the engines ranges npm packages use (bare and x-versions, carets, spaced and v-prefixed comparators, ANDed clauses)', () => {
    expect(satisfies('22.22.2', '^22.22.2 || ^24.15.0 || >=26.0.0')).toBe(true);
    expect(satisfies('24.10.0', '^22.22.2 || ^24.15.0 || >=26.0.0')).toBe(false);
    expect(satisfies('23.0.0', '^22.12.0 || ^24.0.0 || >=26.0.0')).toBe(false);
    expect(satisfies('14.17.0', '>=16 || 14 >=14.17')).toBe(true);
    expect(satisfies('14.16.0', '>=16 || 14 >=14.17')).toBe(false);
    expect(satisfies('13.7.0', '^6 || ^7 || ^8 || ^9 || ^10 || ^11 || ^12 || >=13.7')).toBe(true);
    expect(satisfies('10.0.0', '>= 10.x')).toBe(true);
    expect(satisfies('12.22.7', '>=v12.22.7')).toBe(true);
    expect(satisfies('21.0.0', '18 || 20 || >=22')).toBe(false);
    expect(() => satisfies('22.0.0', '>=22 <banana')).toThrow(/unreadable/);
  });

  it('is the lowest Node every package in package-lock.json accepts, and every place that states it says the same', () => {
    const floor = lowestAcceptedByAll(lockfileRanges());
    expect(NODE_FLOOR).toBe(floor);
    expect(CONTRACT.nodeFloor).toBe(floor);
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(`>=${floor}`);
    expect(/^NODE_FLOOR="([^"]+)"$/m.exec(fs.readFileSync(path.join(DEFAULT_CODE_ROOT, 'custom', 'install', 'install.sh'), 'utf8'))?.[1]).toBe(floor);
    expect(fs.readFileSync(path.join(PACKAGE_ROOT, 'README.md'), 'utf8')).toContain(`when Node is below ${floor}`);
    const forkReadme = fs.readFileSync(path.join(DEFAULT_CODE_ROOT, '.github', 'README.md'), 'utf8');
    expect(forkReadme.match(/Node\.js [\d.]+ or newer/g)).toEqual([`Node.js ${floor} or newer`, `Node.js ${floor} or newer`]);
  });
});

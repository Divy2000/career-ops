import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { describeNodeRange, NODE_FLOOR, NODE_RANGE, nodeSupported, preflight } from '../../supervisor/preflight.js';
import { CONTRACT } from '../../server/core/adapter.js';
import { DEFAULT_CODE_ROOT, PACKAGE_ROOT } from '../../server/config.js';
import { nodeSupported as installerNodeSupported } from '../../../install/lib.mjs';

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

/** A range as the versions it accepts: a sorted union of [lowest, below) intervals (below null: no upper bound). */
type Interval = { lowest: Version; below: Version | null };

function intervals(range: string): Interval[] {
  return alternatives(range).map((all) =>
    all.reduce<Interval>(
      (acc, c) => ({
        lowest: cmp(acc.lowest, c.lowest) >= 0 ? acc.lowest : c.lowest,
        below: acc.below === null ? c.below : c.below === null ? acc.below : cmp(acc.below, c.below) <= 0 ? acc.below : c.below,
      }),
      { lowest: [0, 0, 0], below: null },
    ),
  );
}

/** The versions every range accepts, as intervals: the intersection of all of them. */
function supportedSet(ranges: string[]): Interval[] {
  let set: Interval[] = [{ lowest: [0, 0, 0], below: null }];
  for (const range of ranges) {
    const next: Interval[] = [];
    for (const a of set) {
      for (const b of intervals(range)) {
        const lowest = cmp(a.lowest, b.lowest) >= 0 ? a.lowest : b.lowest;
        const below = a.below === null ? b.below : b.below === null ? a.below : cmp(a.below, b.below) <= 0 ? a.below : b.below;
        if (below === null || cmp(lowest, below) < 0) next.push({ lowest, below });
      }
    }
    set = next.sort((x, y) => cmp(x.lowest, y.lowest));
  }
  return set;
}

/** The set as a range string in the form the app's checkers read: ^X.Y.Z for the rest of a major, >=X.Y.Z, or >=X.Y.Z <A.B.C. */
function rangeString(set: Interval[]): string {
  return set
    .map(({ lowest, below }) => {
      const v = lowest.join('.');
      if (below === null) return `>=${v}`;
      if (lowest[0] > 0 && cmp(below, [lowest[0] + 1, 0, 0]) === 0) return `^${v}`;
      return `>=${v} <${below.join('.')}`;
    })
    .join(' || ');
}

const PROBES = ['22.22.1', '22.22.2', '23.0.0', '24.0.0', '24.15.0', '25.0.0', '26.0.0', '26.4.0'];

describe('the supported Node versions', () => {
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

  it('are the versions every package in package-lock.json accepts, and every place that states them says the same', () => {
    const ranges = lockfileRanges();
    const set = supportedSet(ranges);
    const range = rangeString(set);
    expect(range).toBe('^22.22.2 || ^24.15.0 || >=26.0.0');
    expect(NODE_RANGE).toBe(range);
    expect(CONTRACT.nodeRange).toBe(range);
    const floor = set[0]!.lowest.join('.');
    expect(NODE_FLOOR).toBe(floor);
    expect(CONTRACT.nodeFloor).toBe(floor);
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(range);
    const installSh = fs.readFileSync(path.join(DEFAULT_CODE_ROOT, 'custom', 'install', 'install.sh'), 'utf8');
    expect(/^NODE_RANGE="([^"]+)"$/m.exec(installSh)?.[1]).toBe(range);
    const words = describeNodeRange(range);
    expect(words).toBe('22.22.2+, 24.15+ or 26+');
    expect(/^NODE_SUPPORTED="([^"]+)"$/m.exec(installSh)?.[1]).toBe(words);
    expect(fs.readFileSync(path.join(PACKAGE_ROOT, 'README.md'), 'utf8')).toContain(`when Node is not ${words}`);
    const forkReadme = fs.readFileSync(path.join(DEFAULT_CODE_ROOT, '.github', 'README.md'), 'utf8');
    expect(forkReadme.split(`Node.js ${words}`).length - 1).toBe(2);
    expect(forkReadme).not.toMatch(/Node\.js [\d.]+ or newer/);
  });

  it('the preflight and the installer accept exactly those versions: 22.22.2+, 24.15+ or 26+, never 23, 24.0 to 24.14 or 25', () => {
    const range = rangeString(supportedSet(lockfileRanges()));
    const expected = Object.fromEntries(PROBES.map((v) => [v, lockfileRanges().every((r) => satisfies(v, r))]));
    expect(expected).toEqual({ '22.22.1': false, '22.22.2': true, '23.0.0': false, '24.0.0': false, '24.15.0': true, '25.0.0': false, '26.0.0': true, '26.4.0': true });
    for (const v of PROBES) {
      expect(nodeSupported(`v${v}`, range), `preflight ${v}`).toBe(expected[v]);
      expect(installerNodeSupported(`v${v}`, range), `installer ${v}`).toBe(expected[v]);
    }
    expect(nodeSupported(process.version, NODE_RANGE), `this machine runs ${process.version}`).toBe(true);
    // A range they cannot read accepts nothing.
    expect(nodeSupported('v26.4.0', '>=26 banana')).toBe(false);
    expect(installerNodeSupported('v26.4.0', '>=26 banana')).toBe(false);
  });

  it('the preflight refuses an unsupported Node with the versions to use', async () => {
    const r = await preflight({ claudeBin: process.execPath, nodeVersion: 'v23.0.0', env: { NODE_ENV: 'test' }, approvedVersions: [], platform: 'darwin', managedSettings: { dir: path.join(PACKAGE_ROOT, 'no-such-managed-settings'), plists: [] }, exec: async () => 0 });
    expect(r.errors).toContain('Node 23.0.0 is not supported; use 22.22.2+, 24.15+ or 26+. Install a supported Node.');
  });
});

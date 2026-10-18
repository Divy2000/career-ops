// The invariants in server/domains/blacklist.invariants.md, as table-driven and seeded randomized cases. Each save is
// checked the way PUT /api/blacklist checks it (routes/settings.ts), against scan.mjs parseBlacklist as the reader.
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  BLACKLIST_DATE,
  blacklistOverCap,
  blacklistRowSchema,
  blacklistScannerKey,
  blacklistUnreadRow,
  parseBlacklist,
  renderBlacklist,
  type BlacklistParsed,
  type BlacklistRow,
  type NormalizeTextKey,
} from '../../server/domains/blacklist.js';

const REPO = path.resolve(__dirname, '../../../..');
type ScanEntry = { company: string; since: string; scope: string; reason: string };
const scan = (await import(pathToFileURL(path.join(REPO, 'scan.mjs')).href)) as { parseBlacklist: (t: string) => Map<string, ScanEntry> };
const { normalizeTextKey } = (await import(pathToFileURL(path.join(REPO, 'tracker-parse.mjs')).href)) as { normalizeTextKey: NormalizeTextKey };

/** mulberry32: a small seeded PRNG, so a failing randomized case can be replayed from its printed seed. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const SEED = Number(process.env.BLACKLIST_INVARIANT_SEED ?? 0xb1ac35);
const ITERATIONS = 400;

/** The checks PUT /api/blacklist runs after the ETag, in its order: the error it answers with, or null when it writes. */
function routeRefusal(rows: unknown[], current: BlacklistParsed): string | null {
  const body = z.array(blacklistRowSchema).max(2000).safeParse(rows);
  if (!body.success) return `schema: ${body.error.issues[0]?.message}`;
  if (current.unkept.length) return `unkept: ${current.unkept.join('; ')}`;
  const legacy = new Set(current.rows.map((r) => r.since));
  const badDate = body.data.find((r) => !BLACKLIST_DATE.test(r.since) && !legacy.has(r.since));
  if (badDate) return `date: ${badDate.company}`;
  const knownDomains = new Set(current.rows.filter((r) => r.scope === 'domain').map((r) => r.company));
  const badHost = body.data.find((r) => r.scope === 'domain' && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(r.company) && !knownDomains.has(r.company));
  if (badHost) return `host: ${badHost.company}`;
  const overCap = blacklistOverCap(body.data, current.rows);
  if (overCap) return overCap;
  const overfull = body.data.find((r) => (r.extra?.length ?? 0) > current.extraColumns.length);
  if (overfull) return `overfull: ${overfull.company}`;
  return blacklistUnreadRow(body.data, current.rows, normalizeTextKey);
}

/** What a save writes and the editor reads back: the rows rendered into the file's own layout, parsed again. */
function save(rows: BlacklistRow[], current: BlacklistParsed): { raw: string; back: BlacklistParsed } {
  const raw = renderBlacklist(rows, current.preamble, current.postamble, current.extraColumns);
  return { raw, back: parseBlacklist(raw) };
}

/** A row as a save writes it: every one of the file's extra columns present, empty when the row has no cell for it. */
const padded = (r: BlacklistRow, width: number): BlacklistRow => {
  const { extra, ...rest } = r;
  return width ? { ...rest, extra: Array.from({ length: width }, (_, i) => extra?.[i] ?? '') } : rest;
};

const identity = (r: Pick<BlacklistRow, 'company' | 'scope'>) => `${r.scope}\0${r.company}`;

/** Every `|` line of `md` with its cells, split as scan.mjs splits them (position 0 is the Company cell). */
function pipeLines(md: string): string[][] {
  return md
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .map((l) => {
      const cells = l.split('|').map((c) => c.trim());
      return cells.slice(1, l.trim().endsWith('|') && cells.length > 2 ? -1 : undefined);
    });
}
const scannerSkips = (company: string) => !company || /^[-: ]+$/.test(company) || company.toLowerCase() === 'company';

const COMPANIES = ['Acme', 'acme', 'ACME.', 'Initech', 'initech', '!!!', '&', 'ibm.com', 'IBM.com.', 'Globex Corp', 'Company name', 'x'.repeat(230), ' Spaced '];
const BLANKISH = ['', '---', ':-:', 'Company', 'company'];
const CELLS = ['', '2026-01-01', 'Sept 2025', 'company', 'domain', 'Domain', 'other', 'note', 'T-1', 'r'.repeat(520)];
const SCOPES = ['company', 'domain', 'Domain', ''];
const HEADERS = [
  ['Company', 'Since', 'Scope', 'Reason'],
  ['Company', 'Reason', 'Added'],
  ['Company name', 'Reason'],
  ['Company', 'Since', 'Scope', 'Reason', 'Ticket', 'Contact'],
  ['Company', 'Since', 'Reason', 'Reason'],
  ['Company', 'Since', 'Notes', 'Why', 'Extra', ''],
  ['Company', 'Since', 'Scope', 'Reason', ...Array.from({ length: 55 }, (_, i) => `C${i}`)],
];

/** A random data/blacklist.md: text, an optional table (any header above), and loose `|` lines before and after it. */
function randomFile(rand: () => number): string {
  const row = (width: number) => {
    const first = rand() < 0.85 ? pick(rand, COMPANIES) : pick(rand, BLANKISH);
    const cells = [first, ...Array.from({ length: width - 1 }, (_, i) => (i === 1 && rand() < 0.7 ? pick(rand, SCOPES) : pick(rand, CELLS)))];
    return `| ${cells.join(' | ')} |`;
  };
  const header = pick(rand, HEADERS);
  const width = () => (rand() < 0.8 ? header.length : Math.max(1, header.length + pick(rand, [-1, 1])));
  const lines: string[] = ['# Blacklist', '', 'Intro.'];
  if (rand() < 0.2) lines.push('', row(width()));
  lines.push('');
  if (rand() < 0.9) {
    lines.push(`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`);
    const n = Math.floor(rand() * 6);
    for (let i = 0; i < n; i++) lines.push(row(width()));
  }
  if (rand() < 0.3) lines.push('', '## Notes', '', 'Keep me.');
  if (rand() < 0.3) lines.push('', row(width()));
  if (rand() < 0.2) lines.push('', '| Company | Other |', '|---|---|', row(2));
  return `${lines.join('\n')}\n`;
}

/** One random edit of the rows the editor loaded, as a user could make it. */
function randomEdit(rand: () => number, rows: BlacklistRow[]): BlacklistRow[] {
  const next = rows.map((r) => ({ ...r }));
  const at = () => Math.floor(rand() * Math.max(1, next.length));
  const typed = (): BlacklistRow => {
    const scope = rand() < 0.3 ? 'domain' : 'company';
    const company = scope === 'domain' ? pick(rand, ['ibm.com', 'IBM.com', 'globex.com', 'new.example']) : pick(rand, ['Acme', 'ACME', 'Initech', 'initech', 'INITECH', 'Globex', '!!!', 'Newco']);
    return { company, since: '2026-10-18', scope, reason: pick(rand, ['', 'spam', 'ghosted']) };
  };
  switch (Math.floor(rand() * 6)) {
    case 0:
      next.splice(at(), 0, typed());
      break;
    case 1:
      next.splice(at(), 1);
      break;
    case 2:
      next.reverse();
      break;
    case 3:
      if (next.length) next[at()]!.reason = 'edited';
      break;
    case 4:
      if (next.length) next.splice(at(), 0, { ...next[at()]! });
      break;
    default:
      if (next.length) next[at()] = typed();
  }
  return next;
}

describe('blacklist invariants: reading', () => {
  it('lists every row scan.mjs reads, with the same cells, in random files', () => {
    const rand = prng(SEED);
    for (let i = 0; i < ITERATIONS; i++) {
      const md = randomFile(rand);
      const parsed = parseBlacklist(md);
      for (const entry of scan.parseBlacklist(md).values()) {
        const listed = parsed.rows.some((r) => r.company === entry.company && r.since === entry.since && r.scope === entry.scope && r.reason === entry.reason);
        expect(listed, `seed ${SEED} iteration ${i}: ${JSON.stringify(entry)} not listed in\n${md}`).toBe(true);
      }
      const read = pipeLines(md).filter((cells) => !scannerSkips(cells[0] ?? ''));
      expect(parsed.rows.length, `seed ${SEED} iteration ${i}: one listed row per | line the scanner reads\n${md}`).toBe(read.length);
    }
  });
});

describe('blacklist invariants: a save keeps what the file holds', () => {
  it.each([
    ['a row with an empty Company cell (R31-srv-dom-a-L2-01)', '| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Acme | 2026-01-01 | company | spam |\n|  | 2026-02-01 | company | TODO |\n'],
    ['a dash-only Company cell with a note', '| Company | Since | Scope | Reason |\n|---|---|---|---|\n| -- | 2026-02-01 | company | TODO |\n'],
    ['a row wider than the table', '| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Acme | 2026-01-01 | company | spam | T-9 |\n'],
    ['a scope that is neither company nor domain', '| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Acme | 2026-01-01 | sometimes | spam |\n'],
    ['a loose row past five columns with no table', '| Acme | 2026-01-01 | company | spam | T-9 |\n'],
  ])('given %s, when it is read, then the cell a save would drop is unkept and the save is refused', (_name, md) => {
    const parsed = parseBlacklist(md);
    expect(parsed.unkept.length).toBeGreaterThan(0);
    expect(routeRefusal(parsed.rows, parsed)).toMatch(/^unkept/);
  });

  it('never drops a cell of a | line silently, and a save is a fixed point, in random files', () => {
    const rand = prng(SEED + 1);
    for (let i = 0; i < ITERATIONS; i++) {
      const md = randomFile(rand);
      const parsed = parseBlacklist(md);
      if (parsed.unkept.length) continue;
      const where = `seed ${SEED + 1} iteration ${i}:\n${md}`;
      const { raw, back } = save(parsed.rows, parsed);
      // Every non-empty cell of a line the scanner reads is in a row the save writes (a header label or a separator is
      // no data, and a scope of company or domain is written back as the Scope column).
      const pool = back.rows.map((r) => [r.company, r.since, r.scope, r.reason, ...(r.extra ?? [])]);
      for (const cells of pipeLines(md)) {
        if (scannerSkips(cells[0] ?? '')) {
          if (/^[-: ]*$/.test(cells[0] ?? '') && !cells.every((c) => /^[-: ]*$/.test(c))) {
            expect.fail(`${where}\na line with no company holds ${cells.join(', ')} and is not unkept`);
          }
          continue;
        }
        const wanted = cells.filter((c, j) => c !== '' && !(j === 2 && ['company', 'domain'].includes(c.toLowerCase())));
        const at = pool.findIndex((p) => p[0] === cells[0] && wanted.every((c) => p.includes(c)));
        expect(at, `${where}\nno saved row keeps ${cells.join(' | ')}`).not.toBe(-1);
        pool.splice(at, 1);
      }
      expect(back.unkept, where).toEqual([]);
      expect(back.extraColumns, where).toEqual(parsed.extraColumns);
      expect(back.rows, where).toEqual(parsed.rows.map((r) => padded(r, parsed.extraColumns.length)));
      expect([...scan.parseBlacklist(raw)], where).toEqual([...scan.parseBlacklist(md)]);
      expect(save(back.rows, back).raw, where).toBe(raw);
    }
  });

  it('accepts the rows it listed back unchanged, in any order, in random files (R32-srv-dom-a-X-01, R33-domains-FC-01)', () => {
    const rand = prng(SEED + 2);
    for (let i = 0; i < ITERATIONS; i++) {
      const md = randomFile(rand);
      const parsed = parseBlacklist(md);
      if (parsed.unkept.length) continue;
      const shuffled = [...parsed.rows].sort(() => rand() - 0.5);
      expect(routeRefusal(parsed.rows, parsed), `seed ${SEED + 2} iteration ${i}:\n${md}`).toBeNull();
      expect(routeRefusal(shuffled, parsed), `seed ${SEED + 2} iteration ${i} (shuffled):\n${md}`).toBeNull();
    }
  });

  it('given a table with 55 extra columns, when its rows are saved back, then the save is accepted and keeps every cell (R32-srv-dom-a-X-01)', () => {
    const extras = Array.from({ length: 55 }, (_, i) => `C${i}`);
    const md = `| Company | Since | Scope | Reason | ${extras.join(' | ')} |\n|${['', '', '', '', ...extras].map(() => '---').join('|')}|\n| Acme | 2026-01-01 | company | spam | ${extras.map((c) => c.toLowerCase()).join(' | ')} |\n`;
    const parsed = parseBlacklist(md);
    expect(routeRefusal(parsed.rows, parsed)).toBeNull();
    expect(save(parsed.rows, parsed).back.rows[0]!.extra).toEqual(extras.map((c) => c.toLowerCase()));
  });
});

describe('blacklist invariants: a save writes only rows the scanner reads', () => {
  const FILE = '| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Initech | 2025-03-02 | company | original |\n';
  const initech: BlacklistRow = { company: 'Initech', since: '2025-03-02', scope: 'company', reason: 'original' };
  const row = (company: string, scope: 'company' | 'domain' = 'company'): BlacklistRow => ({ company, since: '2026-10-18', scope, reason: 'new' });

  it.each<[string, string, BlacklistRow[]]>([
    ['"Company", which the scanner reads as a header (R33-srv-dom-a-X-01)', FILE, [initech, row('Company')]],
    ['a dash-only company (R33-srv-dom-a-X-01)', FILE, [initech, row('---')]],
    ['a blank company (R33-srv-dom-a-X-01)', FILE, [initech, row('   ')]],
    ['a company with an empty key (R33-domains-FC-01)', FILE, [initech, row('!!!')]],
    ['a second row of a key (R33-domains-FC-01)', FILE, [initech, row('INITECH.')]],
    ['a new first row in front of a duplicate the file holds (R34-srv-dom-a-X-01)', `${FILE}| initech | 2025-01-02 | company | legacy |\n`, [row('INITECH'), initech]],
    ['a legacy dead duplicate swapped for a new one (R33 leftover)', `${FILE}| initech | 2025-01-02 | company | legacy |\n`, [initech, row('INITECH')]],
    ['a third row of a key the file holds twice', `${FILE}| initech | 2025-01-02 | company | legacy |\n`, [initech, { ...initech, company: 'initech', since: '2025-01-02', reason: 'legacy' }, row('INITECH')]],
    ['a second copy of an empty-key row the file holds', `${FILE}| !!! | 2025-01-01 | company | old |\n`, [initech, { company: '!!!', since: '2025-01-01', scope: 'company', reason: 'old' }, { company: '!!!', since: '2025-01-01', scope: 'company', reason: 'old' }]],
  ])('given %s, when it is saved, then the save is refused', (_name, md, rows) => {
    expect(routeRefusal(rows, parseBlacklist(md))).not.toBeNull();
  });

  it('writes exactly the rows it accepts and no new row the scanner never reads, over random edit sequences', () => {
    const rand = prng(SEED + 3);
    for (let i = 0; i < ITERATIONS; i++) {
      let md = randomFile(rand);
      for (let step = 0; step < 4; step++) {
        const current = parseBlacklist(md);
        if (current.unkept.length) break;
        const rows = randomEdit(rand, current.rows);
        const where = `seed ${SEED + 3} iteration ${i} step ${step}: ${JSON.stringify(rows.map((r) => r.company))}\n${md}`;
        if (routeRefusal(rows, current) !== null) continue;
        const { raw, back } = save(rows, current);
        expect(back.rows, where).toEqual(rows.map((r) => padded(r, current.extraColumns.length)));
        // Each row the scanner skips was already in the file, one for one.
        const heldIds = new Map<string, number>();
        for (const r of current.rows) heldIds.set(identity(r), (heldIds.get(identity(r)) ?? 0) + 1);
        const groups = new Map<string, BlacklistRow[]>();
        for (const r of rows) {
          const k = blacklistScannerKey(r, normalizeTextKey);
          if (!k.empty) groups.set(k.key, [...(groups.get(k.key) ?? []), r]);
        }
        for (const r of rows) {
          const k = blacklistScannerKey(r, normalizeTextKey);
          if (!k.empty && groups.get(k.key)!.length === 1) continue;
          const left = heldIds.get(identity(r)) ?? 0;
          expect(left, `${where}\n${r.company} is a row the scanner never reads and the file did not hold it`).toBeGreaterThan(0);
          heldIds.set(identity(r), left - 1);
        }
        md = raw;
      }
    }
  });
});

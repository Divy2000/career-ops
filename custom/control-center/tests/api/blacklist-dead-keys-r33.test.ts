// scan.mjs keys every blacklist row by normalizeCompany (company scope) or the trimmed, lowercased host (domain scope),
// skips a row whose key is empty and keeps only the first row of a key. A save must not write a row the scanner never
// reads; a file that already holds such rows stays savable (R33-domains-FC-01).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeTestApp } from '../helpers/app.js';

const EXPLICIT = { 'x-cc-explicit': 'blacklist' };
const FILE = '# Blacklist\n\n| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Initech | 2025-03-02 | company | ghosted |\n';

async function scannerKeys(raw: string): Promise<string[]> {
  const scan = (await import(pathToFileURL(path.resolve(__dirname, '../../../../scan.mjs')).href)) as { parseBlacklist: (t: string) => Map<string, unknown> };
  return [...scan.parseBlacklist(raw).keys()];
}

async function withApp(file: string, fn: (save: (rows: unknown[]) => Promise<{ status: number; body: string }>, abs: string) => Promise<void>): Promise<void> {
  const app = await makeTestApp();
  try {
    const abs = path.join(app.cfg.dataRoot, 'data', 'blacklist.md');
    fs.writeFileSync(abs, file);
    const save = async (rows: unknown[]) => {
      const current = (await app.app.inject({ method: 'GET', url: '/api/blacklist', headers: app.authed })).json();
      const r = await app.app.inject({ method: 'PUT', url: '/api/blacklist', headers: { ...app.authedWrite, 'if-match': current.etag, ...EXPLICIT }, payload: { confirm: true, rows } });
      return { status: r.statusCode, body: r.body };
    };
    await fn(save, abs);
  } finally {
    await app.close();
  }
}

const initech = { company: 'Initech', since: '2025-03-02', scope: 'company', reason: 'ghosted' };

describe('blacklist rows the scanner skips by key', () => {
  it.each([
    ['a company whose normalized key is empty', [initech, { company: '!!!', since: '2026-10-03', scope: 'company', reason: 'x' }], /scanner skips !!!/],
    ['a company that normalizes to a key already listed', [initech, { company: 'INITECH.', since: '2026-10-03', scope: 'company', reason: 'x' }], /INITECH\..*Initech/],
    ['a domain already listed in another case', [initech, { company: 'globex.com', since: '2026-10-03', scope: 'domain', reason: '' }, { company: 'GLOBEX.com', since: '2026-10-03', scope: 'domain', reason: '' }], /GLOBEX\.com.*globex\.com/],
  ])('given %s, when it is saved, then it is refused and nothing is written', async (_name, rows, message) => {
    await withApp(FILE, async (save, abs) => {
      const saved = await save(rows);
      expect(saved.status, saved.body).toBe(400);
      expect(JSON.parse(saved.body).error).toMatch(message);
      expect(fs.readFileSync(abs, 'utf8')).toBe(FILE);
    });
  });

  it('given the same name under company and domain scope, when it is saved, then both are written and the scanner reads both', async () => {
    await withApp(FILE, async (save, abs) => {
      const saved = await save([initech, { company: 'initech.com', since: '2026-10-03', scope: 'domain', reason: '' }, { company: 'Initech Com', since: '2026-10-03', scope: 'company', reason: '' }]);
      expect(saved.status, saved.body).toBe(200);
      expect(await scannerKeys(fs.readFileSync(abs, 'utf8'))).toHaveLength(3);
    });
  });

  it('given a file that already holds an empty-key row and a duplicate, when a new row is added, then the save succeeds and keeps every row', async () => {
    const legacy = `${FILE}| !!! | 2025-01-01 | company | old |\n| initech | 2025-01-02 | company | dup |\n`;
    await withApp(legacy, async (save, abs) => {
      const rows = [initech, { company: '!!!', since: '2025-01-01', scope: 'company', reason: 'old' }, { company: 'initech', since: '2025-01-02', scope: 'company', reason: 'dup' }, { company: 'Globex', since: '2026-10-03', scope: 'company', reason: 'spam' }];
      const saved = await save(rows);
      expect(saved.status, saved.body).toBe(200);
      const raw = fs.readFileSync(abs, 'utf8');
      for (const c of ['| !!! |', '| initech |', '| Initech |', '| Globex |']) expect(raw).toContain(c);
    });
  });

  it('given a file that already holds one duplicate, when a second duplicate of that key is added, then it is refused', async () => {
    const legacy = `${FILE}| initech | 2025-01-02 | company | dup |\n`;
    await withApp(legacy, async (save) => {
      const rows = [initech, { company: 'initech', since: '2025-01-02', scope: 'company', reason: 'dup' }, { company: 'INITECH', since: '2026-10-03', scope: 'company', reason: 'again' }];
      const saved = await save(rows);
      expect(saved.status, saved.body).toBe(400);
    });
  });

  it('given a file that already holds one empty-key row, when a second copy of it is added, then it is refused', async () => {
    const legacy = `${FILE}| !!! | 2025-01-01 | company | old |\n`;
    await withApp(legacy, async (save, abs) => {
      const dead = { company: '!!!', since: '2025-01-01', scope: 'company', reason: 'old' };
      const saved = await save([initech, dead, dead]);
      expect(saved.status, saved.body).toBe(400);
      expect(fs.readFileSync(abs, 'utf8')).toBe(legacy);
    });
  });

  it('given a file that already holds one duplicate, when it is swapped for a newly typed duplicate of that key, then it is refused', async () => {
    const legacy = `${FILE}| initech | 2025-01-02 | company | dup |\n`;
    await withApp(legacy, async (save) => {
      const saved = await save([initech, { company: 'INITECH', since: '2026-10-03', scope: 'company', reason: 'new' }]);
      expect(saved.status, saved.body).toBe(400);
    });
  });

  it('given a file that already holds a duplicate, when the two rows are saved in swapped order, then the save succeeds', async () => {
    const legacy = `${FILE}| initech | 2025-01-02 | company | dup |\n`;
    await withApp(legacy, async (save) => {
      const saved = await save([{ company: 'initech', since: '2025-01-02', scope: 'company', reason: 'dup' }, initech]);
      expect(saved.status, saved.body).toBe(200);
    });
  });
});

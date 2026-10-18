// The blacklist editor carries a file's unmanaged columns through a save. A table the editor loads must stay savable,
// however many such columns it has; the save already refuses a row with more cells than the file has columns
// (R32-srv-dom-a-X-01).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp } from '../helpers/app.js';

const EXPLICIT = { 'x-cc-explicit': 'blacklist' };
const wideTable = (extra: number) => {
  const names = Array.from({ length: extra }, (_, i) => `Note ${i + 1}`);
  const cells = names.map((_, i) => `n${i + 1}`);
  return `# Blacklist\n\n| Company | Since | Scope | Reason | ${names.join(' | ')} |\n|${'---|'.repeat(4 + extra)}\n| Initech | 2025-03-02 | company | ghosted | ${cells.join(' | ')} |\n`;
};

describe('blacklist tables with many unmanaged columns', () => {
  it('given a file with 55 columns after Reason, when the editor loads it and saves a new row, then the save succeeds and keeps every cell', async () => {
    const app = await makeTestApp();
    try {
      const file = path.join(app.cfg.dataRoot, 'data', 'blacklist.md');
      fs.writeFileSync(file, wideTable(55));
      const req = (method: 'GET' | 'PUT', payload?: Record<string, unknown>, extra: Record<string, string> = {}) => app.app.inject({ method, url: '/api/blacklist', headers: { ...(method === 'GET' ? app.authed : app.authedWrite), ...extra }, payload });
      const current = (await req('GET')).json();
      expect(current.extraColumns).toHaveLength(55);
      expect(current.rows[0].extra).toHaveLength(55);
      const rows = [...current.rows, { company: 'Globex', since: '2026-10-03', scope: 'company', reason: 'spam' }];
      const saved = await req('PUT', { confirm: true, rows }, { 'if-match': current.etag, ...EXPLICIT });
      expect(saved.statusCode, saved.body).toBe(200);
      const raw = fs.readFileSync(file, 'utf8');
      expect(raw).toContain('| Note 55 |');
      expect(raw).toContain('| n54 | n55 |');
      expect(raw).toContain('| Globex | 2026-10-03 | company | spam |');
    } finally {
      await app.close();
    }
  });

  it('given a file with 2 columns after Reason, when a row with 3 extra cells is saved, then it is refused and nothing is written', async () => {
    const app = await makeTestApp();
    try {
      const file = path.join(app.cfg.dataRoot, 'data', 'blacklist.md');
      fs.writeFileSync(file, wideTable(2));
      const before = fs.readFileSync(file, 'utf8');
      const req = (method: 'GET' | 'PUT', payload?: Record<string, unknown>, extra: Record<string, string> = {}) => app.app.inject({ method, url: '/api/blacklist', headers: { ...(method === 'GET' ? app.authed : app.authedWrite), ...extra }, payload });
      const current = (await req('GET')).json();
      const rows = [{ ...current.rows[0], extra: ['a', 'b', 'c'] }];
      const saved = await req('PUT', { confirm: true, rows }, { 'if-match': current.etag, ...EXPLICIT });
      expect(saved.statusCode, saved.body).toBe(400);
      expect(saved.json().error).toMatch(/more cells than data\/blacklist\.md has columns \(2 extra\)/);
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    } finally {
      await app.close();
    }
  });
});

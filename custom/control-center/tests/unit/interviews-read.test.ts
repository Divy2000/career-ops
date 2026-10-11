// readInterviews lists interview-prep documents; a file removed between listing and stat (a session rewriting its
// notes) is simply gone, not a failed read, while any other stat error still fails the load (R23-srv-dom-a-X-01).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readInterviews } from '../../server/domains/contacts.js';
import { tempDir } from '../helpers/tmp.js';

afterEach(() => vi.restoreAllMocks());

function rootWithDocs(...names: string[]) {
  const root = tempDir('cc-interviews-read-');
  fs.mkdirSync(path.join(root, 'interview-prep'), { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(root, 'interview-prep', n), `# ${n}\n`);
  return root;
}

function statFailsFor(name: string, code: string) {
  const real = fs.statSync;
  vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
    if (String(p).endsWith(name)) throw Object.assign(new Error(`${code}: ${String(p)}`), { code });
    return real(p, o);
  }) as typeof fs.statSync);
}

describe('readInterviews', () => {
  it('leaves out a document deleted between listing the folder and reading its size', () => {
    const root = rootWithDocs('acme-prep.md', 'globex-prep.md');
    statFailsFor('globex-prep.md', 'ENOENT');
    expect(readInterviews(root).prepDocs.map((d) => d.name)).toEqual(['acme-prep.md']);
  });
  it('still fails the read when a document cannot be read for any other reason', () => {
    const root = rootWithDocs('acme-prep.md');
    statFailsFor('acme-prep.md', 'EACCES');
    expect(() => readInterviews(root)).toThrow(/EACCES/);
  });
});

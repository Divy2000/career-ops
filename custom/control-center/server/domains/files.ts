import fs from 'node:fs';
import crypto from 'node:crypto';

/** A missing file is not a malformed file (web/AGENTS.md): callers branch on `kind`. */
export type TextRead = { kind: 'missing'; path: string } | { kind: 'ok'; path: string; text: string; etag: string; mtimeMs: number };

export function etagOf(text: string): string {
  return `"${crypto.createHash('sha256').update(text).digest('hex')}"`;
}

export function readText(path: string): TextRead {
  try {
    const text = fs.readFileSync(path, 'utf8');
    const mtimeMs = fs.statSync(path).mtimeMs;
    return { kind: 'ok', path, text, etag: etagOf(text), mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', path };
    throw err;
  }
}

export class ParseError extends Error {
  constructor(
    message: string,
    public file: string,
    public line: number | null = null,
  ) {
    super(message);
  }
}

/** Split TSV text into rows keyed by the header; blank lines are skipped. */
export function parseTsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0]!.split('\t');
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ''));
    return row;
  });
}

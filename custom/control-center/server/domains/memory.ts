// "Remember" facts from the Ask drawer land in a managed block inside
// modes/_profile.md, using the same markers as the web alpha so the CLI and
// TUI see them too.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../lib/atomic-write.js';

export const NOTES_START = '<!-- co-web-notes:start -->';
export const NOTES_END = '<!-- co-web-notes:end -->';

export function applyRememberedFact(md: string, fact: string): { text: string; result: 'ok' | 'deduped' } {
  const f = fact.trim().replace(/\s+/g, ' ').slice(0, 300);
  if (!f) return { text: md, result: 'deduped' };
  const i = md.indexOf(NOTES_START);
  const j = md.indexOf(NOTES_END);
  if (i !== -1 && j !== -1 && j > i) {
    if (md.slice(i, j).includes(f)) return { text: md, result: 'deduped' };
    return { text: md.slice(0, j) + `- ${f}\n` + md.slice(j), result: 'ok' };
  }
  if (md.includes(f)) return { text: md, result: 'deduped' };
  const section = `\n\n## Notes from the web assistant\n${NOTES_START}\n- ${f}\n${NOTES_END}\n`;
  const base = md.trim() ? md.replace(/\n*$/, '\n') : '# Profile customization\n';
  return { text: base + section, result: 'ok' };
}

export function rememberFact(dataRoot: string, fact: string): 'ok' | 'deduped' {
  const p = path.join(dataRoot, 'modes', '_profile.md');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let md = '';
  try {
    md = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const { text, result } = applyRememberedFact(md, fact);
  if (result === 'ok') {
    writeFileAtomic(p, text);
  }
  return result;
}

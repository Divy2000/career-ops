// "Remember" facts from the Ask drawer land in a managed block inside
// modes/_profile.md, using the same markers as the web alpha so the CLI and
// TUI see them too.
import fs from 'node:fs';
import path from 'node:path';
import { dataRootOnly, writeFileAtomic } from '../lib/atomic-write.js';

export const NOTES_START = '<!-- co-web-notes:start -->';
export const NOTES_END = '<!-- co-web-notes:end -->';

/**
 * True when one whole line of `text` (a bullet's text, or a plain line) is the fact. Only a whole line: a fact inside a
 * longer one may say the opposite ("open to relocation" in "Not open to relocation").
 */
function holdsLine(text: string, fact: string): boolean {
  return text.split(/\r?\n/).some((l) => l.trim().replace(/^[-*]\s+/, '').replace(/\s+/g, ' ') === fact);
}

export function applyRememberedFact(md: string, fact: string): { text: string; result: 'ok' | 'deduped' } {
  // The fact may come from a model that read a JD: no HTML comment opener or closer, so it can never forge or end the
  // managed block.
  const f = fact.replace(/<!--|-->/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 300);
  if (!f) return { text: md, result: 'deduped' };
  const i = md.indexOf(NOTES_START);
  // The block's own end: the first end marker after its start, never a stray one above it.
  const j = i === -1 ? -1 : md.indexOf(NOTES_END, i + NOTES_START.length);
  if (i !== -1 && j !== -1 && j > i) {
    if (holdsLine(md.slice(i, j), f)) return { text: md, result: 'deduped' };
    return { text: md.slice(0, j) + `- ${f}\n` + md.slice(j), result: 'ok' };
  }
  if (holdsLine(md, f)) return { text: md, result: 'deduped' };
  const section = `\n\n## Notes from the web assistant\n${NOTES_START}\n- ${f}\n${NOTES_END}\n`;
  const base = md.trim() ? md.replace(/\n*$/, '\n') : '# Profile customization\n';
  return { text: base + section, result: 'ok' };
}

/** Remember before onboarding: a bare modes/_profile.md would pass doctor's checks and stop --init-templates from copying the template. */
export class ProfileMissingError extends Error {
  constructor() {
    super('modes/_profile.md does not exist yet: run the onboarding interview (Profile & CV > AI flows) first, then remember facts; nothing was written');
  }
}

export function rememberFact(dataRoot: string, fact: string): 'ok' | 'deduped' {
  const p = path.join(dataRoot, 'modes', '_profile.md');
  let md: string;
  try {
    md = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ProfileMissingError();
    throw err;
  }
  const { text, result } = applyRememberedFact(md, fact);
  if (result === 'ok') {
    writeFileAtomic(p, text, dataRootOnly(dataRoot));
  }
  return result;
}

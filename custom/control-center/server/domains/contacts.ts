// data/contacts.tsv (contacts.mjs format: no header row, a leading # comment,
// tab-separated name, company, type, title, phone, email, linkedin, tracker#, notes)
// and the interview-prep folder read model.
import fs from 'node:fs';
import path from 'node:path';
import { readText, type TextRead } from './files.js';

export interface ContactRow {
  line: number;
  name: string;
  company: string;
  type: string;
  title: string;
  phone: string;
  email: string;
  linkedin: string;
  tracker: number | null;
  notes: string;
}

export type ContactsRead = { kind: 'missing'; path: string } | { kind: 'ok'; path: string; rows: ContactRow[]; skipped: number };

export const CONTACTS_REL = 'data/contacts.tsv';

export function parseContacts(text: string): { rows: ContactRow[]; skipped: number } {
  const rows: ContactRow[] = [];
  let skipped = 0;
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.startsWith('#')) return;
    const c = line.split('\t').map((x) => x.trim());
    if (!c[0] || !c[1]) {
      skipped += 1;
      return;
    }
    const tracker = c[7] && /^\d+$/.test(c[7]) ? Number(c[7]) : null;
    rows.push({ line: i + 1, name: c[0], company: c[1], type: c[2] ?? '', title: c[3] ?? '', phone: dash(c[4]), email: dash(c[5]), linkedin: dash(c[6]), tracker, notes: dash(c[8]) });
  });
  return { rows, skipped };
}

const dash = (v: string | undefined) => (v === undefined || v === '-' ? '' : v);

export function readContacts(dataRoot: string): ContactsRead {
  const read = readText(path.join(dataRoot, CONTACTS_REL));
  if (read.kind === 'missing') return { kind: 'missing', path: CONTACTS_REL };
  return { kind: 'ok', path: CONTACTS_REL, ...parseContacts(read.text) };
}

export interface PrepDoc {
  name: string;
  path: string;
  mtimeMs: number;
  size: number;
}

export interface InterviewsRead {
  active: TextRead;
  storyBank: TextRead;
  prepDocs: PrepDoc[];
  sessions: PrepDoc[];
}

function listMd(dir: string, rel: string, exclude: Set<string>): PrepDoc[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !exclude.has(e.name))
    .map((e) => {
      const st = fs.statSync(path.join(dir, e.name));
      return { name: e.name, path: `${rel}/${e.name}`, mtimeMs: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** data/active-interviews.md, else the root copy: the order process-quality.mjs, rejection-latency.mjs and tracker-sync-check.mjs use. */
function readActiveInterviews(dataRoot: string): TextRead {
  const documented = readText(path.join(dataRoot, 'data', 'active-interviews.md'));
  if (documented.kind === 'ok') return documented;
  const legacy = readText(path.join(dataRoot, 'active-interviews.md'));
  return legacy.kind === 'ok' ? legacy : documented;
}

export function readInterviews(dataRoot: string): InterviewsRead {
  const dir = path.join(dataRoot, 'interview-prep');
  const strip = (r: TextRead): TextRead => (r.kind === 'ok' ? { ...r, path: path.relative(dataRoot, r.path) } : { kind: 'missing', path: path.relative(dataRoot, r.path) });
  return {
    active: strip(readActiveInterviews(dataRoot)),
    storyBank: strip(readText(path.join(dir, 'story-bank.md'))),
    prepDocs: listMd(dir, 'interview-prep', new Set(['active-interviews.md', 'story-bank.md'])),
    sessions: listMd(path.join(dir, 'sessions'), 'interview-prep/sessions', new Set()),
  };
}

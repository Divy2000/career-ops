import path from 'node:path';
import { readText } from './files.js';

export interface ShortlistRow {
  rank: number;
  score: number | null;
  relevance: number | null;
  sponsor: string;
  company: string;
  role: string;
  url: string | null;
  location: string | null;
  posted: string | null;
  why: string | null;
}

export interface ExcludedRow {
  company: string;
  role: string;
  url: string | null;
  alert: string;
  date: string | null;
  headline: string;
}

export type ShortlistRead =
  | { kind: 'missing'; path: string }
  | { kind: 'ok'; path: string; date: string | null; summary: string | null; rows: ShortlistRow[]; excluded: ExcludedRow[]; etag: string };

function cells(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((s) => s.trim());
}

function num(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dash(v: string | undefined): string | null {
  if (!v || v === '-' || v === String.fromCharCode(0x2014)) return null;
  return v;
}

// shortlist.mjs writes `- Company - [Title](url) - label`, the label being `status (date): headline` (custom/pipeline/lib.mjs sponsorAdjustment).
const EXCLUDED_BULLET = /^- (.+?) - \[(.*)\]\((\S*)\) - (.*)$/;
const ALERT_LABEL = /^(\S+) \((\d{4}-\d{2}-\d{2})\): (.*)$/;

function excludedRow(line: string): ExcludedRow | null {
  const m = line.match(EXCLUDED_BULLET);
  if (!m) return null;
  const label = m[4]!.trim();
  const alert = label.match(ALERT_LABEL);
  return { company: m[1]!.trim(), role: m[2]!, url: m[3] || null, alert: alert ? alert[1]! : label, date: alert ? alert[2]! : null, headline: alert ? alert[3]! : '' };
}

export function parseShortlist(md: string): Omit<Extract<ShortlistRead, { kind: 'ok' }>, 'kind' | 'path' | 'etag'> {
  const date = md.match(/^#\s+Shortlist\s*-\s*(\d{4}-\d{2}-\d{2})/m)?.[1] ?? null;
  const summary = md.split('\n').find((l) => /^Ranked rows/i.test(l)) ?? null;
  const rows: ShortlistRow[] = [];
  const excluded: ExcludedRow[] = [];
  let table: 'ranked' | 'excluded' | null = null;
  for (const line of md.split('\n')) {
    if (/^##\s+Excluded/i.test(line)) {
      table = 'excluded';
      continue;
    }
    if (/^##\s+/.test(line)) {
      table = null;
      continue;
    }
    if (table === 'excluded') {
      const row = excludedRow(line);
      if (row) excluded.push(row);
      continue;
    }
    if (!line.startsWith('|')) continue;
    const c = cells(line);
    if (c.every((x) => /^:?-+:?$/.test(x))) continue;
    if (table === null && /^#$/.test(c[0] ?? '')) {
      table = 'ranked';
      continue;
    }
    if (table === 'ranked') {
      const rank = parseInt(c[0] ?? '', 10);
      if (Number.isNaN(rank)) continue;
      const roleCell = c[5] ?? '';
      const link = roleCell.match(/^\[(.*)\]\((\S+)\)$/);
      rows.push({
        rank,
        score: num(c[1]),
        relevance: num(c[2]),
        sponsor: c[3] ?? '',
        company: c[4] ?? '',
        role: link ? link[1]! : roleCell,
        url: link ? link[2]! : null,
        location: dash(c[6]),
        posted: dash(c[7]),
        why: dash(c[8]),
      });
    }
  }
  return { date, summary, rows, excluded };
}

export function readShortlist(dataRoot: string): ShortlistRead {
  const p = path.join(dataRoot, 'data', 'shortlist.md');
  const read = readText(p);
  if (read.kind === 'missing') return { kind: 'missing', path: p };
  return { kind: 'ok', path: p, etag: read.etag, ...parseShortlist(read.text) };
}

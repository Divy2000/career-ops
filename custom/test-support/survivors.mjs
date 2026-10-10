#!/usr/bin/env node
// Lists the surviving mutants in Stryker JSON reports, one line each: `file:line | mutator | original -> mutated`.
// Usage: node custom/test-support/survivors.mjs <mutation.json> [<mutation.json> ...]
// File paths are printed relative to the repo root (each report stores its package's directory as projectRoot).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The source text a mutant replaces: its location is 1-based lines and 0-based columns, end exclusive. */
function original(source, { start, end }) {
  const lines = source.split('\n');
  if (start.line === end.line) return lines[start.line - 1].slice(start.column, end.column);
  return [lines[start.line - 1].slice(start.column), ...lines.slice(start.line, end.line - 1), lines[end.line - 1].slice(0, end.column)].join('\n');
}

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

function survivorLines(report, root) {
  const out = [];
  for (const [file, { source, mutants }] of Object.entries(report.files)) {
    const rel = path.relative(repo, path.resolve(root, file));
    for (const m of mutants) {
      if (m.status !== 'Survived') continue;
      out.push({ rel, line: m.location.start.line, column: m.location.start.column, text: `${rel}:${m.location.start.line} | ${m.mutatorName} | ${oneLine(original(source, m.location))} -> ${oneLine(m.replacement ?? '')}` });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line || a.column - b.column).map((s) => s.text);
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node custom/test-support/survivors.mjs <mutation.json> [...]');
  process.exit(2);
}
for (const f of files) {
  const report = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!report.projectRoot) throw new Error(`${f} has no projectRoot; it is not a Stryker mutation.json report`);
  for (const line of survivorLines(report, report.projectRoot)) console.log(line);
}

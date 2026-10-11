#!/usr/bin/env node
// Import projects into the projects library (article-digest.md) from an
// AutoJobApply-style projects.json, a JSON Resume file or `projects` array, or
// another library .md. Dry run by default: prints the library markdown on
// stdout and, on stderr, how each project's text compares with cv.md.
//
//   node custom/projects/import.mjs <file.json|file.md> [--dry-run | --write] [--merge]
//
// --write creates article-digest.md and refuses when it already exists unless
// --merge is given; --merge appends only projects whose title is not there yet.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, renameSync, linkSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  parseLibrary,
  validateLibrary,
  serializeEntry,
  serializeLibrary,
  appendBlock,
  convertJsonProjects,
  findCvProject,
  wordDiff,
  titleKey,
} from './lib.mjs';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { validateFlags } from '../../lib/cli-flags.mjs';
import { withPipelineLock } from '../../pipeline-lock.mjs';

const DATA = getCareerOpsRoot();
const TARGET = path.join(DATA, 'article-digest.md');
const CV = path.join(DATA, 'cv.md');
const USAGE = `Usage:
  node custom/projects/import.mjs <file.json|file.md> [--dry-run | --write] [--merge]
    --dry-run  print the library markdown and the cv.md comparison (default)
    --write    write article-digest.md (refused when it exists, unless --merge)
    --merge    add only projects whose title is not in article-digest.md yet`;

const plural = (n) => `${n} project${n === 1 ? '' : 's'}`;

async function readInput(file, label) {
  const raw = await readFile(file, 'utf8');
  if (/\.(md|markdown)$/i.test(file)) {
    const check = validateLibrary(raw);
    if (!check.ok) {
      for (const e of check.errors) process.stderr.write(`error: ${e}\n`);
      throw new Error(`${label} is not a valid projects library`);
    }
    const { entries } = parseLibrary(raw);
    return { entries, blocks: entries.map((e) => raw.slice(e.start, e.end)), wholeText: raw };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}`);
  }
  const { entries, warnings } = convertJsonProjects(data);
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
  return { entries, blocks: entries.map(serializeEntry), wholeText: null };
}

function compareWithCv(entries, cvText) {
  for (const e of entries) {
    const found = findCvProject(cvText, e.title);
    if (!found) {
      process.stderr.write(`+ ${e.title} is not in cv.md\n`);
      continue;
    }
    const diff = wordDiff(found.text, e.bullets.join(' '));
    process.stderr.write(diff
      ? `~ ${e.title} differs from cv.md line ${found.line}: ${diff}\n`
      : `= ${e.title} matches cv.md line ${found.line}\n`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  validateFlags(args, ['--dry-run', '--write', '--merge', '--help', '-h'], USAGE);
  const write = args.includes('--write');
  const merge = args.includes('--merge');
  if (write && args.includes('--dry-run')) throw new Error('use either --dry-run or --write, not both');
  const operands = args.filter((a) => !a.startsWith('-'));
  if (operands.length !== 1) throw new Error(`expected one input file\n${USAGE}`);
  const file = path.resolve(operands[0]);
  if (!existsSync(file)) throw new Error(`input file not found: ${file}`);

  const { entries, blocks, wholeText } = await readInput(file, operands[0]);
  if (!entries.length) throw new Error(`no projects found in ${operands[0]}`);

  // Two --write runs would each read the library and publish a replacement built from it, the later dropping the
  // other's projects: from the existence check through the publish, a write holds article-digest.md's lock.
  const job = () => importInto({ entries, blocks, wholeText, write, merge });
  await (write ? withPipelineLock(TARGET, job) : job());
}

async function importInto({ entries, blocks, wholeText, write, merge }) {
  const exists = existsSync(TARGET);
  // The library as this run read it (null: none yet), which the publish checks is still what is on disk.
  let base = null;
  let kept = entries.map((_, i) => i);
  let next;
  let printed;
  if (exists && merge) {
    const current = await readFile(TARGET, 'utf8');
    base = current;
    const have = new Set(parseLibrary(current).entries.map((e) => titleKey(e.title)));
    kept = kept.filter((i) => !have.has(titleKey(entries[i].title)));
    for (const e of entries.filter((_, i) => !kept.includes(i))) {
      process.stderr.write(`skipped (already in article-digest.md): ${e.title}\n`);
    }
    next = kept.reduce((text, i) => appendBlock(text, blocks[i]), current);
    printed = kept.length ? `${kept.map((i) => blocks[i]).join('\n\n---\n\n')}\n` : '';
  } else {
    if (exists && write) {
      throw new Error(`article-digest.md already exists at ${TARGET}; rerun with --merge to add only new projects`);
    }
    if (exists) process.stderr.write(`note: article-digest.md already exists at ${TARGET}; --write will need --merge\n`);
    next = wholeText ?? serializeLibrary(entries);
    printed = next;
  }

  const check = validateLibrary(next);
  for (const w of check.warnings) process.stderr.write(`warning: ${w}\n`);
  if (!check.ok) {
    for (const e of check.errors) process.stderr.write(`error: ${e}\n`);
    throw new Error('the result would not be a valid projects library; nothing written');
  }

  if (existsSync(CV)) compareWithCv(kept.map((i) => entries[i]), await readFile(CV, 'utf8'));
  else process.stderr.write(`note: no cv.md at ${CV}; skipped the comparison\n`);

  if (!write) {
    process.stdout.write(printed);
    process.stderr.write(`dry run: nothing written (${plural(kept.length)} for ${TARGET}); rerun with --write to save\n`);
    return;
  }
  if (!kept.length) {
    process.stdout.write(`nothing new to add to ${TARGET}\n`);
    return;
  }
  const tmp = `${TARGET}.tmp-${process.pid}`;
  await writeFile(tmp, next);
  publish(tmp, base);
  process.stdout.write(`wrote ${plural(kept.length)} to ${TARGET}\n`);
}

// The lock keeps other imports out, but the Control Center writes article-digest.md without it (an ETag check and an
// atomic rename). So the replacement goes in only if the library is still the one this run read, checked and
// published with no await in between: a fresh library is hard-linked into place, which fails if one appeared.
function publish(tmp, base) {
  try {
    if (base === null) {
      try {
        linkSync(tmp, TARGET);
      } catch (err) {
        if (err.code === 'EEXIST') throw new Error(`article-digest.md was created while importing (the Control Center may have saved a project); nothing written, rerun with --merge`);
        throw err;
      }
      return;
    }
    if ((existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : null) !== base) {
      throw new Error(`article-digest.md changed while importing (the Control Center may have saved a project); nothing written, rerun to merge into the current library`);
    }
    renameSync(tmp, TARGET);
  } finally {
    rmSync(tmp, { force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`import failed: ${err.message}\n`);
  process.exit(1);
});

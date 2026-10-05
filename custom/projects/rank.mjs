#!/usr/bin/env node
// Rank the projects library (article-digest.md) against a job description.
// Deterministic, zero LLM tokens: skill overlap via upstream skill-extract.mjs
// plus tag keywords. Entries whose kind is not `project` are listed as
// excluded. The agent makes the final pick from `candidates`.
//
//   node custom/projects/rank.mjs <jd.md> [--json | --summary]
//   node custom/projects/rank.mjs --check
//
// A relative JD path is tried from the current directory, then the data root.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseLibrary, validateLibrary, rankProjects } from './lib.mjs';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { validateFlags } from '../../lib/cli-flags.mjs';

const DATA = getCareerOpsRoot();
const LIBRARY = path.join(DATA, 'article-digest.md');
const CV = path.join(DATA, 'cv.md');
const USAGE = `Usage:
  node custom/projects/rank.mjs <jd.md> [--json | --summary]   rank library projects for a JD (summary is the default)
  node custom/projects/rank.mjs --check                        validate article-digest.md`;

function resolveJd(arg) {
  const fromCwd = path.resolve(arg);
  if (path.isAbsolute(arg) || existsSync(fromCwd)) return fromCwd;
  return path.join(DATA, arg);
}

function summary(result) {
  const title = new Map(result.candidates.map((c) => [c.id, c.title]));
  const lines = [`Recommended: ${result.recommended.map((id) => title.get(id)).join(', ') || 'none (no project matches this JD)'}`, ''];
  result.candidates.forEach((c, i) => {
    lines.push(`${i + 1}. ${c.title} - score ${c.score}${c.inCv ? ', in cv.md' : ''}${c.matchedSkills.length ? ` - ${c.matchedSkills.join(', ')}` : ''}`);
  });
  if (result.excluded.length) {
    lines.push('', `Excluded (not projects): ${result.excluded.map((e) => `${e.title} (${e.kind})`).join(', ')}`);
  }
  const coverage = Object.entries(result.libraryCoverage);
  if (coverage.length) {
    lines.push('', 'JD skills missing from cv.md but shown by a library project:');
    for (const [skill, ids] of coverage) lines.push(`- ${skill}: ${ids.map((id) => title.get(id)).join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  validateFlags(args, ['--json', '--summary', '--check', '--help', '-h'], USAGE);
  const json = args.includes('--json');
  if (json && args.includes('--summary')) throw new Error('use either --json or --summary, not both');
  const operands = args.filter((a) => !a.startsWith('-'));

  if (!existsSync(LIBRARY)) {
    throw new Error(`article-digest.md not found at ${LIBRARY}. Create it there (custom/projects/import.mjs can build it from a projects JSON), or point CAREER_OPS_ROOT at the directory that has it.`);
  }
  const text = await readFile(LIBRARY, 'utf8');
  const check = validateLibrary(text);
  for (const w of check.warnings) process.stderr.write(`warning: ${w}\n`);

  if (args.includes('--check')) {
    for (const e of check.errors) process.stderr.write(`error: ${e}\n`);
    const { entries } = parseLibrary(text);
    const projects = entries.filter((e) => e.kind === 'project').length;
    process.stdout.write(`${LIBRARY}: ${entries.length} entries (${projects} projects), ${check.errors.length} errors, ${check.warnings.length} warnings\n`);
    process.exit(check.ok ? 0 : 1);
  }

  if (operands.length !== 1) throw new Error(`expected one JD file\n${USAGE}`);
  const jdPath = resolveJd(operands[0]);
  if (!existsSync(jdPath)) throw new Error(`JD file not found: ${operands[0]} (tried ${path.resolve(operands[0])} and ${jdPath})`);
  if (!check.ok) {
    for (const e of check.errors) process.stderr.write(`error: ${e}\n`);
    throw new Error('article-digest.md has errors; fix them (see node custom/projects/rank.mjs --check) before ranking');
  }
  let cvText = '';
  if (existsSync(CV)) cvText = await readFile(CV, 'utf8');
  else process.stderr.write(`warning: cv.md not found at ${CV}; inCv is false for every project and libraryCoverage compares against nothing\n`);

  const result = rankProjects(parseLibrary(text).entries, { jdText: await readFile(jdPath, 'utf8'), cvText });
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : summary(result));
}

main().catch((err) => {
  process.stderr.write(`rank failed: ${err.message}\n`);
  process.exit(1);
});

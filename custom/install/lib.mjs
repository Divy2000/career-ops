// Pure helpers for custom/install/install.sh. Plain ESM with no dependencies, so it also runs on the
// older Node the installer is about to complain about.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MiB = 1024 * 1024;
export const LIMITS = {
  resumeBytes: 1 * MiB,
  docBytes: 2 * MiB,
  maxDocs: 20,
  totalBytes: 10 * MiB,
};

export function versionAtLeast(actual, floor) {
  const a = String(actual).replace(/^v/, '').split('.').map(Number);
  const f = String(floor).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0;
    const y = f[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

const LOCAL_PATHS_HEADER = '# Files this checkout owns that upstream does not ship (added by custom/install/install.sh).\n';

/** The new config/local-paths.txt text with `custom/` declared, or null when it already is. */
export function mergeLocalPaths(text) {
  const present = text.split(/\r?\n/).some((l) => l.trim() === 'custom/');
  if (present) return null;
  if (text === '') return `${LOCAL_PATHS_HEADER}custom/\n`;
  return `${text}${text.endsWith('\n') ? '' : '\n'}custom/\n`;
}

/** `name.ext` if free, else `name-1.ext`, `name-2.ext`, ... `taken` is a Set (or anything with has()). */
export function uniqueDestName(base, taken) {
  if (!taken.has(base)) return base;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function normalizeMarkdown(text) {
  const body = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  return `${body}\n`;
}

export function normalizeRepoUrl(url) {
  return String(url)
    .trim()
    .replace(/^git@([^:]+):/, '$1/')
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .toLowerCase();
}

export function sameRepo(a, b) {
  return normalizeRepoUrl(a) === normalizeRepoUrl(b);
}

/** Counts and a bounded preview of `diff -u` output; the header lines are not counted as changes. */
export function summarizeUnifiedDiff(diffText, previewLines = 40) {
  const lines = diffText.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) added++;
    else if (l.startsWith('-')) removed++;
  }
  return { added, removed, preview: lines.slice(0, previewLines) };
}

/** Reads `node doctor.mjs --json` output. Anything unparseable is "not ready", never an exception. */
export function parseDoctorState(text) {
  const notReady = { ready: false, missing: [], unpersonalized: [] };
  let json = null;
  for (const candidate of [text, text.slice(Math.max(text.indexOf('{'), 0))]) {
    try {
      json = JSON.parse(candidate);
      break;
    } catch {
      // try the next candidate
    }
  }
  if (!json || typeof json !== 'object') return notReady;
  const missing = Array.isArray(json.missing) ? json.missing.map(String) : [];
  const unpersonalized = (Array.isArray(json.unpersonalized) ? json.unpersonalized : []).map((u) => String(u?.path ?? u));
  return { ready: json.onboardingNeeded === false && missing.length === 0 && unpersonalized.length === 0, missing, unpersonalized };
}

const ONBOARD_BASE = 'Read custom/install/ONBOARDING.md and follow it.';

export function interactiveOnboardPrompt({ cv, docs }) {
  const inputs = [];
  if (cv) inputs.push(`cv.md (from ${cv})`);
  inputs.push(...docs);
  return inputs.length === 0 ? ONBOARD_BASE : `${ONBOARD_BASE} Inputs: ${inputs.join(', ')}`;
}

export function renderHeadlessPrompt(template, { draftDir, inputs }) {
  return template.replaceAll('{{DRAFT_DIR}}', draftDir).replaceAll('{{INPUTS}}', inputs.length ? inputs.join(', ') : 'none provided');
}

/** `--flag value` pairs; the flags named in `listFlags` take every value up to the next `--flag`. Returns Map(flag -> string | string[]). */
export function parseFlags(argv, listFlags = []) {
  const out = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const list = listFlags.includes(a);
    const values = [];
    while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) values.push(argv[++i]);
    out.set(a, list ? values : values.length ? values[0] : true);
  }
  return out;
}

const EXT_OK = new Set(['.md', '.markdown']);
const PROMPT_HINT = 'use option 1 (Claude Code prompt) for PDF, DOCX and other formats';

/**
 * Checks one Markdown input without writing anything.
 * Returns { ok: true, path, realpath, bytes, warnings } or { ok: false, error }.
 */
export function validateMarkdownInput(file, { kind, targetCv } = {}) {
  const label = file;
  let real;
  try {
    real = fs.realpathSync(file);
  } catch {
    return { ok: false, error: `${label}: file does not exist` };
  }
  const st = fs.statSync(real);
  if (!st.isFile()) return { ok: false, error: `${label}: not a regular file` };
  if (!EXT_OK.has(path.extname(file).toLowerCase())) {
    return { ok: false, error: `${label}: the script accepts Markdown (.md or .markdown) only; ${PROMPT_HINT}` };
  }
  const limit = kind === 'resume' ? LIMITS.resumeBytes : LIMITS.docBytes;
  if (st.size > limit) return { ok: false, error: `${label}: ${st.size} bytes is over the ${limit / MiB} MiB limit for ${kind === 'resume' ? 'the resume' : 'a doc'}` };
  if (kind === 'resume' && targetCv) {
    let targetReal = null;
    try {
      targetReal = fs.realpathSync(targetCv);
    } catch {
      targetReal = null;
    }
    if (targetReal && targetReal === real) return { ok: false, error: `${label}: this is the target cv.md itself; pass a copy of your resume` };
  }
  const buf = fs.readFileSync(real);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return { ok: false, error: `${label}: not valid UTF-8` };
  }
  if (text.includes('\0')) return { ok: false, error: `${label}: contains NUL bytes (binary file?)` };
  if (text.replace(/^﻿/, '').trim() === '') return { ok: false, error: `${label}: file is empty` };
  const warnings = [];
  if (!/^#{1,6}\s/m.test(text)) warnings.push(`${label}: no '#' heading found`);
  if (kind === 'resume' && !/^#{1,6}\s.*\b(experience|education|skills)\b/im.test(text)) {
    warnings.push(`${label}: none of the Experience, Education or Skills headings found`);
  }
  return { ok: true, path: file, realpath: real, bytes: st.size, warnings };
}

/** Validates the resume and every doc up front; nothing is written whether or not this passes. */
export function validateInputs({ resume, docs = [], targetCv } = {}) {
  const errors = [];
  const warnings = [];
  let total = 0;
  const take = (r) => {
    if (r.ok) {
      total += r.bytes;
      warnings.push(...r.warnings);
    } else errors.push(r.error);
  };
  if (resume) take(validateMarkdownInput(resume, { kind: 'resume', targetCv }));
  if (docs.length > LIMITS.maxDocs) errors.push(`--docs: ${docs.length} files given, at most ${LIMITS.maxDocs} are accepted`);
  for (const d of docs) take(validateMarkdownInput(d, { kind: 'doc', targetCv }));
  if (total > LIMITS.totalBytes) errors.push(`inputs total ${total} bytes, over the ${LIMITS.totalBytes / MiB} MiB limit`);
  return { ok: errors.length === 0, errors, warnings };
}

// Small CLI used by install.sh: node lib.mjs <command> [args]
function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'version-ge':
      return versionAtLeast(rest[0], rest[1]) ? 0 : 1;
    case 'same-repo':
      return sameRepo(rest[0], rest[1]) ? 0 : 1;
    case 'doctor-state': {
      const s = parseDoctorState(fs.readFileSync(0, 'utf8'));
      process.stdout.write(`${s.ready ? 'ready' : 'incomplete'}\t${[...s.missing, ...s.unpersonalized].join(',')}\n`);
      return 0;
    }
    case 'onboard-prompt': {
      const [cv, ...docs] = rest;
      process.stdout.write(`${interactiveOnboardPrompt({ cv: cv || null, docs })}\n`);
      return 0;
    }
    case 'render-headless': {
      const [templateFile, draftDir, ...inputs] = rest;
      process.stdout.write(renderHeadlessPrompt(fs.readFileSync(templateFile, 'utf8'), { draftDir, inputs }));
      return 0;
    }
    default:
      process.stderr.write('usage: lib.mjs version-ge|same-repo|doctor-state|onboard-prompt|render-headless ...\n');
      return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) process.exitCode = main(process.argv.slice(2));

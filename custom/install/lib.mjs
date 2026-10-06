// Pure helpers for custom/install/install.sh. Plain ESM with no dependencies, so it also runs on the
// older Node the installer is about to complain about.
import fs from 'node:fs';
import path from 'node:path';

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

function fullVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Whether `version` is in `range`, written as the Control Center's NODE_RANGE is (supervisor/preflight.ts, whose test
 * checks this copy too): alternatives joined by ||, each one or more of ^X.Y.Z (that major, from X.Y.Z), >=X.Y.Z and
 * <X.Y.Z. A range or version it cannot read accepts nothing.
 */
export function nodeSupported(version, range) {
  const v = fullVersion(version);
  if (!v) return false;
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  return String(range).split('||').some((alt) => {
    const terms = alt.trim().split(/\s+/).filter(Boolean);
    return terms.length > 0 && terms.every((term) => {
      const m = /^(\^|>=|<)(\d+\.\d+\.\d+)$/.exec(term);
      const b = m ? fullVersion(m[2]) : null;
      if (!m || !b) return false;
      if (m[1] === '<') return compare(v, b) < 0;
      return compare(v, b) >= 0 && (m[1] === '>=' || v[0] === b[0]);
    });
  });
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
  // The "--- a" / "+++ b" file headers come before the first hunk; after it, a line starting with "---" or "+++" is
  // content (a removed "---" rule, an added "++x" line) and counts like any other.
  let inHunk = false;
  for (const l of lines) {
    if (l.startsWith('@@')) inHunk = true;
    if (!inHunk) continue;
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
  // One pass with a replacer function: a string replacement would expand $&, $$, $` and $' inside a path, and a second
  // pass would fill a placeholder that the first one's path happened to contain.
  const values = { DRAFT_DIR: draftDir, INPUTS: inputs.length ? inputs.join(', ') : 'none provided' };
  return template.replace(/\{\{(DRAFT_DIR|INPUTS)\}\}/g, (_, key) => values[key]);
}

/** `--flag value` pairs; the flags named in `listFlags` take every value up to the next `--flag`. Returns Map(flag -> string | string[]). */
const PLACEHOLDER = '(none yet -- add yours above)';

/**
 * Add a shipped house-rule block (it starts with its own `### Title (...)` heading) to the
 * `## House Rules` section of modes/_custom.md. Null when the heading is already there.
 * It replaces the template's placeholder line when that is all the section holds, else it
 * goes after the section's last line; every other byte stays.
 */
export function insertHouseRule(text, block) {
  const body = block.replace(/\s+$/, '');
  const title = body.split('\n')[0].replace(/\s*\(.*$/, '').trim();
  const lines = text.split('\n');
  if (lines.some((l) => l.trim() === title || l.startsWith(`${title} `) || l.startsWith(`${title}(`))) return null;
  const start = lines.findIndex((l) => /^## House Rules\s*$/.test(l));
  if (start === -1) return `${text.replace(/\s+$/, '')}\n\n## House Rules\n\n${body}\n`;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  const section = lines.slice(start + 1, end).join('\n');
  const content = section.replace(/<!--[\s\S]*?-->/g, '').split('\n').map((l) => l.trim()).filter((l) => l && l !== PLACEHOLDER);
  const placeholder = lines.findIndex((l, i) => i > start && i < end && l.trim() === PLACEHOLDER);
  if (content.length === 0 && placeholder !== -1) {
    lines.splice(placeholder, 1, ...body.split('\n'));
    return lines.join('\n');
  }
  let last = end - 1;
  while (last > start && !lines[last].trim()) last--;
  lines.splice(last + 1, 0, '', ...body.split('\n'));
  return lines.join('\n');
}

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

/**
 * Absolute path with symlinks resolved. For a path that does not exist yet, the deepest existing ancestor is resolved
 * and the missing tail is appended, so /tmp/x and /private/tmp/x compare equal before x is created.
 */
export function canonicalPath(p) {
  const abs = path.resolve(p);
  const tail = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
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
  const decoded = decodeText(fs.readFileSync(real), label);
  if (!decoded.ok) return decoded;
  const { text } = decoded;
  const warnings = [];
  if (!/^#{1,6}\s/m.test(text)) warnings.push(`${label}: no '#' heading found`);
  if (kind === 'resume' && !/^#{1,6}\s.*\b(experience|education|skills)\b/im.test(text)) {
    warnings.push(`${label}: none of the Experience, Education or Skills headings found`);
  }
  return { ok: true, path: file, realpath: real, bytes: st.size, warnings };
}

// The byte-level checks every text input gets: strict UTF-8 (no silent replacement), no NUL, not empty.
function decodeText(buf, label) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return { ok: false, error: `${label}: not valid UTF-8` };
  }
  if (text.includes('\0')) return { ok: false, error: `${label}: contains NUL bytes (binary file?)` };
  if (text.replace(/^\ufeff/, '').trim() === '') return { ok: false, error: `${label}: file is empty` };
  return { ok: true, text };
}

const PROJECTS_EXT = new Set(['.md', '.markdown', '.json']);

/** --projects: a library .md or a projects .json, with the same byte checks and size cap as a --docs file. Returns the decoded text. */
export function validateProjectsInput(file) {
  const label = file;
  let real;
  try {
    real = fs.realpathSync(file);
  } catch {
    return { ok: false, error: `${label}: file does not exist` };
  }
  const st = fs.statSync(real);
  if (!st.isFile()) return { ok: false, error: `${label}: not a regular file` };
  if (!PROJECTS_EXT.has(path.extname(file).toLowerCase())) return { ok: false, error: `${label}: --projects takes a .md, .markdown or .json file` };
  if (st.size > LIMITS.docBytes) return { ok: false, error: `${label}: ${st.size} bytes is over the ${LIMITS.docBytes / MiB} MiB limit for the projects file` };
  const decoded = decodeText(fs.readFileSync(real), label);
  if (!decoded.ok) return decoded;
  return { ok: true, path: file, realpath: real, bytes: st.size, text: decoded.text };
}

/** Validates the resume and every doc up front; nothing is written whether or not this passes. */
export function validateInputs({ resume, docs = [], projects, targetCv } = {}) {
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
  if (projects) {
    const r = validateProjectsInput(projects);
    if (!r.ok) errors.push(r.error);
  }
  return { ok: errors.length === 0, errors, warnings };
}

// Small CLI used by install.sh through cli.mjs: node cli.mjs <command> [args]
export function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'version-ge':
      return versionAtLeast(rest[0], rest[1]) ? 0 : 1;
    case 'node-supported':
      return nodeSupported(rest[0], rest[1]) ? 0 : 1;
    case 'same-repo':
      return sameRepo(rest[0], rest[1]) ? 0 : 1;
    case 'same-path':
      return canonicalPath(rest[0]) === canonicalPath(rest[1]) ? 0 : 1;
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
      process.stderr.write('usage: cli.mjs version-ge|node-supported|same-repo|same-path|doctor-state|onboard-prompt|render-headless ...\n');
      return 2;
  }
}

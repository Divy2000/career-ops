// Temp dirs for the custom/*/tests specs. tempDir() tracks every dir it makes and a file-level after()
// hook removes them all, so a test run leaves nothing in TMPDIR. Loading this module is also the guard: the spec
// process, and every child it starts with the inherited environment, works in a private temp dir, and when the
// process exits whatever is left there is listed, removed and fails the file. A suite tmp-guard spec checks with
// specsWithoutTmpCheck() that every spec of its suite loads this module; runSuiteInFreshTmp() is the older guard,
// which re-runs a whole suite in a child process with a fresh TMPDIR.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';

const OWN_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-check-'));
// os.tmpdir() reads TEMP or TMP before TMPDIR on Windows.
for (const key of ['TMPDIR', 'TEMP', 'TMP']) process.env[key] = OWN_TMP;
let ownTmpRemoved = false;
// A kill by signal skips 'exit': when nothing else handles the signal, the dir is removed and the signal raised again.
// A spec with its own handler keeps running, so its dir stays and the 'exit' check below still runs.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, function onSignal() {
    if (process.listenerCount(signal) > 0) return;
    ownTmpRemoved = true;
    fs.rmSync(OWN_TMP, { recursive: true, force: true });
    process.kill(process.pid, signal);
  });
}
process.on('exit', () => {
  if (ownTmpRemoved) return;
  let left;
  try {
    left = fs.readdirSync(OWN_TMP).sort();
  } catch (err) {
    // A spec that removed the dir itself left nothing in it; any other error is a real failure to check.
    if (err.code === 'ENOENT') return;
    throw err;
  }
  fs.rmSync(OWN_TMP, { recursive: true, force: true });
  if (!left.length) return;
  process.stderr.write(`test-support/tmp.mjs: this spec left ${left.length} entr${left.length === 1 ? 'y' : 'ies'} in its temp dir (now removed): ${left.join(', ')}\n`);
  process.exitCode = 1;
});

const made = [];
// Registered when the module loads, so it hangs off the file's root, not off whichever test calls tempDir first.
after(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

export function tempDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

/**
 * The environment for a guard child: `tmp` as TMPDIR, TEMP and TMP (os.tmpdir() reads TEMP or TMP before
 * TMPDIR on Windows), no NODE_TEST_CONTEXT, which, inherited from this test process, makes the child
 * skip every file, no FORCE_COLOR, whose escapes would split the summary suiteRanTests reads, and no test
 * reporter in NODE_OPTIONS but spec or tap.
 */
export function suiteEnv(base, tmp) {
  const { NODE_TEST_CONTEXT: _ctx, FORCE_COLOR: _color, ...env } = base;
  const out = { ...env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  // A reporter the caller chose in NODE_OPTIONS other than spec or tap (dot, junit...), or a destination that sends the
  // report elsewhere, leaves no summary suiteRanTests can read.
  if (env.NODE_OPTIONS !== undefined) out.NODE_OPTIONS = readableTestReporter(env.NODE_OPTIONS);
  return out;
}

/**
 * NODE_OPTIONS keeping only the first test reporter whose summary the suite checks read (spec, tap), and no
 * --test-reporter-destination; each flag in either `=` or spaced form. One reporter at most: node --test refuses
 * several reporters without a destination for each.
 */
export function readableTestReporter(options) {
  let kept = false;
  return options
    .replace(/(^|\s)--test-reporter(-destination)?(?:=|\s+)(\S+)/g, (whole, lead, dest, value) => {
      if (dest || kept || !/^(spec|tap)$/.test(value)) return lead;
      kept = true;
      return whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether a `node --test` run's stdout reports at least one test. Node 22 prints TAP ("# tests N") when stdout
 * is not a TTY and Node 23+ prints the spec reporter's "ℹ tests N", so both summaries count.
 */
export function suiteRanTests(stdout) {
  return /^(?:#|ℹ) tests [1-9]/m.test(stdout);
}

/** Runs every *.spec.mjs in `testsDir` except `exclude` with the temp dir pointing at a fresh one; returns the run and what it left behind. */
export function runSuiteInFreshTmp(testsDir, exclude) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-guard-'));
  try {
    const files = fs.readdirSync(testsDir).filter((f) => f.endsWith('.spec.mjs') && f !== exclude).map((f) => path.join(testsDir, f));
    const r = spawnSync(process.execPath, ['--test', ...files], { env: suiteEnv(process.env, tmp), encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
    if (files.length && !suiteRanTests(`${r.stdout}`)) throw new Error(`the suite did not run in the child:\n${r.stdout}\n${r.stderr}`.slice(-4000));
    return { status: r.status, output: `${r.stdout}\n${r.stderr}`, leftovers: fs.readdirSync(tmp).sort() };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const IMPORT_RE = /^[ \t]*(?:import|export)\b[^;'"]*?(?:\bfrom\s*)?['"]([^'"]+)['"]/gm;
const REGEX_AFTER = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const WORD_RE = /[\w$]+/y;
const REGEX_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await', 'delete', 'new', 'instanceof']);

/**
 * `src` with comments, template literals and regex literals removed in one pass, keeping their newlines and every
 * quoted string, so an import line inside a template or a comment opener inside a string is not read as code.
 */
function staticCode(src) {
  let out = '';
  let i = 0;
  let lastSig = '';
  let lastWord = '';
  // One entry per open `${`: the brace depth inside that substitution; closing it at depth 0 resumes the template.
  const subs = [];
  const keepNewlines = (from, to) => { out += src.slice(from, to).replace(/[^\n]/g, ''); };
  // Skips template text from just past its opening backtick or the `}` closing a substitution.
  const skipTemplate = () => {
    const start = i;
    for (; i < src.length && src[i] !== '`'; i++) {
      if (src[i] === '\\') i++;
      else if (src[i] === '$' && src[i + 1] === '{') { keepNewlines(start, i); i += 2; subs.push(0); lastSig = '{'; lastWord = ''; return; }
    }
    keepNewlines(start, ++i);
    lastSig = '"';
    lastWord = '';
  };
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      keepNewlines(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      const start = i;
      for (i++; i < src.length && src[i] !== c && src[i] !== '\n'; i++) if (src[i] === '\\') i++;
      out += src.slice(start, ++i);
      lastSig = '"';
      lastWord = '';
    } else if (c === '`') {
      i++;
      skipTemplate();
    } else if (c === '/' && (lastSig === '' || REGEX_AFTER.has(lastSig) || REGEX_WORDS.has(lastWord))) {
      let cls = false;
      for (i++; i < src.length && src[i] !== '\n'; i++) {
        if (src[i] === '\\') i++;
        else if (src[i] === '[') cls = true;
        else if (src[i] === ']') cls = false;
        else if (src[i] === '/' && !cls) break;
      }
      // A `/` that was really a division ends at the newline, which stays in the output.
      if (src[i] === '/') for (i++; /[a-z]/.test(src[i] ?? ''); i++);
      out += ' ';
      lastSig = '"';
      lastWord = '';
    } else if (c === '}' && subs.length && subs[subs.length - 1] === 0) {
      subs.pop();
      i++;
      skipTemplate();
    } else {
      if (subs.length && c === '{') subs[subs.length - 1]++;
      else if (subs.length && c === '}') subs[subs.length - 1]--;
      if (/[\w$]/.test(c)) {
        WORD_RE.lastIndex = i;
        const word = WORD_RE.exec(src)[0];
        out += word;
        i += word.length;
        lastSig = 'a';
        lastWord = word;
        continue;
      }
      out += c;
      i++;
      if (!/\s/.test(c)) { lastSig = c; lastWord = ''; }
    }
  }
  return out;
}

/**
 * The *.spec.mjs files in `testsDir` (by name, sorted) whose static imports, followed through relative helper modules,
 * never reach `tmpModule` (this module by default), so their run is not checked for temp leftovers.
 */
export function specsWithoutTmpCheck(testsDir, tmpModule = fileURLToPath(import.meta.url)) {
  const target = fs.realpathSync(tmpModule);
  const reaches = (file, seen) => {
    const real = fs.realpathSync(file);
    if (real === target) return true;
    if (seen.has(real)) return false;
    seen.add(real);
    for (const [, spec] of staticCode(fs.readFileSync(real, 'utf8')).matchAll(IMPORT_RE)) {
      if (!spec.startsWith('.')) continue;
      const next = path.resolve(path.dirname(real), spec);
      if (fs.existsSync(next) && reaches(next, seen)) return true;
    }
    return false;
  };
  return fs.readdirSync(testsDir).filter((f) => f.endsWith('.spec.mjs') && !reaches(path.join(testsDir, f), new Set())).sort();
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';
import { spawnCpuLimited } from '../../test-support/cpu-limit.mjs';
import { caseFlippedHome } from '../../test-support/case-home.mjs';
import { isNestedCheckout } from '../../../lib/mjs-files.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(HERE, '..', 'seed.mjs');
const VALIDATE = path.join(HERE, '..', 'validate-md.mjs');
const LIB = path.join(HERE, '..', 'lib.mjs');
const CLI = path.join(HERE, '..', 'cli.mjs');

const tmp = () => tempDir('ci-seed-');
const runNode = (args, options = {}) => spawnCpuLimited(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
const run = (script, args, limits = {}) => runNode([script, ...args], limits);
const seed = (args) => run(SEED, args);
const put = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
};
const nodeScript = (body) => put(path.join(tmp(), 'script.mjs'), body);

test('Given a loaded machine, a seed CLI run is bounded by CPU time, not by a tight wall-clock timeout (R34-flake-walltime)', () => {
  const r = run(nodeScript("import { execFileSync } from 'node:child_process';\nprocess.stdout.write(execFileSync('sh', ['-c', 'ulimit -t'], { encoding: 'utf8' }));\n"), []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '30\n');
});

test('Given a seed CLI run that spins in a loop, it is still killed instead of hanging the suite (R34-flake-walltime)', () => {
  const r = run(nodeScript('for (;;);\n'), [], { cpuSeconds: 1 });
  assert.equal(r.status, null);
  assert.ok(r.signal, 'the spinning run was not killed');
});

test('Given a seed CLI run that never ends while using no CPU, it is still killed instead of hanging the suite (R34-flake-walltime)', () => {
  const r = run(nodeScript('setInterval(() => {}, 1000);\n'), [], { hangMs: 1000 });
  assert.equal(r.status, null);
  assert.ok(r.signal, 'the blocked run was not killed');
});

const tree = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!isNestedCheckout(f)) walk(f);
      } else out[path.relative(dir, f)] = fs.readFileSync(f).toString('base64');
    }
  };
  walk(dir);
  return out;
};

test('validate-md prints JSON and exits 0 for good input, with warnings on stderr', () => {
  const d = tmp();
  const r = put(path.join(d, 'r.md'), 'plain words\n');
  const res = run(VALIDATE, ['--resume', r]);
  assert.equal(res.status, 0);
  const json = JSON.parse(res.stdout);
  assert.equal(json.ok, true);
  assert.equal(json.warnings.length, 2);
  assert.match(res.stderr, /warning:/);
});

test('validate-md exits 2 naming file and reason for a bad doc, and treats --docs values as a list', () => {
  const d = tmp();
  const r = put(path.join(d, 'r.md'), '# A\n');
  const a = put(path.join(d, 'a.md'), '# A\n');
  const res = run(VALIDATE, ['--resume', r, '--docs', a, put(path.join(d, 'b.pdf'), '%PDF-1.4\n')]);
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stdout).ok, false);
  assert.match(res.stderr, /b\.pdf/);
  assert.match(res.stderr, /option 1 \(Claude Code prompt\)/);
});

test('validate-md rejects a resume equal to the --cv target', () => {
  const d = tmp();
  const cv = put(path.join(d, 'cv.md'), '# Me\n');
  const res = run(VALIDATE, ['--resume', cv, '--cv', cv]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /target cv\.md/);
});

test('seed local-paths creates, then merges once, keeping other lines', () => {
  const d = tmp();
  assert.equal(seed(['local-paths', '--dir', d]).stdout.trim(), 'added');
  const f = path.join(d, 'config', 'local-paths.txt');
  assert.match(fs.readFileSync(f, 'utf8'), /^custom\/$/m);
  fs.writeFileSync(f, 'mine/\n');
  assert.equal(seed(['local-paths', '--dir', d]).stdout.trim(), 'added');
  assert.equal(fs.readFileSync(f, 'utf8'), 'mine/\ncustom/\n');
  assert.equal(seed(['local-paths', '--dir', d]).stdout.trim(), 'present');
  assert.equal(fs.readFileSync(f, 'utf8'), 'mine/\ncustom/\n');
});

test('seed custom-template copies only when absent and never overwrites', () => {
  const d = tmp();
  const t = put(path.join(d, 't.md'), 'TEMPLATE\n');
  const data = path.join(d, 'data');
  assert.equal(seed(['custom-template', '--data', data, '--template', t]).stdout.trim(), 'created');
  const target = path.join(data, 'modes', '_custom.md');
  assert.equal(fs.readFileSync(target, 'utf8'), 'TEMPLATE\n');
  fs.writeFileSync(target, 'SENTINEL-MINE\n');
  assert.equal(seed(['custom-template', '--data', data, '--template', t]).stdout.trim(), 'exists');
  assert.equal(fs.readFileSync(target, 'utf8'), 'SENTINEL-MINE\n');
});

test('copy-documents puts the resume in documents/cv and docs in documents/projects, byte for byte', () => {
  const d = tmp();
  const raw = '﻿# Jane\r\nbody\r\n';
  const r = put(path.join(d, 'src', 'resume.md'), raw);
  const a = put(path.join(d, 'src', 'proj.md'), '# P\n');
  const data = path.join(d, 'data');
  const res = seed(['copy-documents', '--data', data, '--resume', r, '--docs', a]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim().split('\n').join('|'), `copied\tresume\t${path.join(data, 'documents/cv/resume.md')}|copied\tdoc\t${path.join(data, 'documents/projects/proj.md')}`);
  assert.equal(fs.readFileSync(path.join(data, 'documents/cv/resume.md'), 'utf8'), raw);
});

test('copy-documents gives a different file of the same name a -1 suffix and never overwrites', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const existing = put(path.join(data, 'documents/projects/proj.md'), 'EXISTING\n');
  const a = put(path.join(d, 'src', 'proj.md'), '# New\n');
  const res = seed(['copy-documents', '--data', data, '--docs', a]);
  assert.match(res.stdout, /copied\tdoc\t.*proj-1\.md/);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'EXISTING\n');
  assert.equal(fs.readFileSync(path.join(data, 'documents/projects/proj-1.md'), 'utf8'), '# New\n');
});

test('Given a doc whose extension holds regex characters, copy-documents copies it, and a twin with the same suffix is reused (R35-scripts-b-X-02)', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  for (const name of ['project.[', 'notes.(', 'a.b\\']) {
    const a = put(path.join(d, 'src', name), `${name}\n`);
    const res = seed(['copy-documents', '--data', data, '--docs', a]);
    assert.equal(res.status, 0, `${name}: ${res.stderr}`);
    assert.equal(res.stdout.trim(), `copied\tdoc\t${path.join(data, 'documents/projects', name)}`);
    assert.match(seed(['copy-documents', '--data', data, '--docs', a]).stdout, /^present\tdoc\t/);
  }
  put(path.join(data, 'documents/projects/x.md'), 'OTHER\n');
  put(path.join(data, 'documents/projects/x-2.md'), 'TWIN\n');
  const twin = seed(['copy-documents', '--data', data, '--docs', put(path.join(d, 'src', 'x.md'), 'TWIN\n')]);
  assert.equal(twin.stdout.trim(), `present\tdoc\t${path.join(data, 'documents/projects/x-2.md')}`);
});

test('Given an identical file whose name only matches the doc name as a regex, copy-documents still copies the doc under its own name (R35-scripts-b-X-02)', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  put(path.join(data, 'documents/projects/proj.ppp'), 'SAME\n');
  put(path.join(data, 'documents/projects/projxmd'), 'SAME\n');
  for (const name of ['proj.p+', 'proj.md']) {
    const res = seed(['copy-documents', '--data', data, '--docs', put(path.join(d, 'src', name), 'SAME\n')]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), `copied\tdoc\t${path.join(data, 'documents/projects', name)}`);
  }
});

test('copy-documents is idempotent: an identical earlier copy is reported present, not duplicated', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const a = put(path.join(d, 'src', 'proj.md'), '# New\n');
  seed(['copy-documents', '--data', data, '--docs', a]);
  const again = seed(['copy-documents', '--data', data, '--docs', a]);
  assert.match(again.stdout, /present\tdoc\t.*proj\.md/);
  assert.deepEqual(fs.readdirSync(path.join(data, 'documents/projects')), ['proj.md']);
});

test('copy-documents never writes article-digest.md or anything outside documents/', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const r = put(path.join(d, 'src', 'resume.md'), '# R\n');
  seed(['copy-documents', '--data', data, '--resume', r]);
  assert.deepEqual(Object.keys(tree(data)), ['documents/cv/resume.md']);
});

test('cv-status reports absent, identical after normalization, and differs with counts and a preview', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const r = put(path.join(d, 'resume.md'), '﻿# Jane\r\nline one\r\n');
  assert.equal(seed(['cv-status', '--data', data, '--resume', r]).stdout.trim(), 'absent');
  put(path.join(data, 'cv.md'), '# Jane\nline one\n');
  assert.equal(seed(['cv-status', '--data', data, '--resume', r]).stdout.trim(), 'identical');
  put(path.join(data, 'cv.md'), '# Jane\nold line\n');
  const out = seed(['cv-status', '--data', data, '--resume', r]).stdout.trim().split('\n');
  assert.equal(out[0], 'differs');
  assert.ok(out.includes('added\t1'));
  assert.ok(out.includes('removed\t1'));
  assert.ok(out.some((l) => l === 'diff\t-old line'));
  assert.ok(out.some((l) => l === 'diff\t+line one'));
});

test('cv-write seeds an absent cv.md with the normalized resume and refuses to touch an existing one', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const r = put(path.join(d, 'resume.md'), '﻿# Jane\r\nline\r\n\r\n');
  const first = seed(['cv-write', '--data', data, '--resume', r]);
  assert.equal(first.stdout.trim(), 'created');
  assert.equal(fs.readFileSync(path.join(data, 'cv.md'), 'utf8'), '# Jane\nline\n');
  fs.writeFileSync(path.join(data, 'cv.md'), 'MINE\n');
  const second = seed(['cv-write', '--data', data, '--resume', r]);
  assert.notEqual(second.status, 0);
  assert.equal(fs.readFileSync(path.join(data, 'cv.md'), 'utf8'), 'MINE\n');
});

test('cv-write --replace backs up the old cv.md byte for byte, then replaces it atomically', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const r = put(path.join(d, 'resume.md'), '# New\n');
  put(path.join(data, 'cv.md'), 'OLD\r\nbytes\n');
  const res = seed(['cv-write', '--data', data, '--resume', r, '--replace']);
  const [kind, backup] = res.stdout.trim().split('\t');
  assert.equal(kind, 'replaced');
  assert.match(path.basename(backup), /^cv\.md\.bak-\d{8}T\d{6}/);
  assert.equal(fs.readFileSync(backup, 'utf8'), 'OLD\r\nbytes\n');
  assert.equal(fs.readFileSync(path.join(data, 'cv.md'), 'utf8'), '# New\n');
  assert.deepEqual(fs.readdirSync(data).filter((n) => n.includes('tmp')), []);
});

test('cv-write --replace on an identical cv.md is a no-op with no backup', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const r = put(path.join(d, 'resume.md'), '# Same\r\n');
  put(path.join(data, 'cv.md'), '# Same\n');
  const res = seed(['cv-write', '--data', data, '--resume', r, '--replace']);
  assert.equal(res.stdout.trim(), 'identical');
  assert.deepEqual(fs.readdirSync(data), ['cv.md']);
});

test('lib.mjs is a library: running it directly executes no command (cli.mjs is the entry point)', () => {
  const r = run(LIB, ['version-ge', 'v20.0.0', '22.6.0']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
});

test('cli.mjs doctor-state reads stdin and prints a ready or incomplete line', () => {
  const ready = spawnSync(process.execPath, [CLI, 'doctor-state'], { input: '{"onboardingNeeded":false,"missing":[],"unpersonalized":[]}', encoding: 'utf8' });
  assert.equal(ready.stdout, 'ready\t\n');
  const late = spawnSync(process.execPath, [CLI, 'doctor-state'], { input: '{"onboardingNeeded":true,"missing":["cv.md"],"unpersonalized":[]}', encoding: 'utf8' });
  assert.equal(late.stdout.trim(), 'incomplete\tcv.md');
});

test('cli.mjs node-supported exits 0 for a Node in the range and 1 otherwise, the gaps between majors included', () => {
  const range = '^22.22.2 || ^24.15.0 || >=26.0.0';
  for (const v of ['v22.22.2', 'v24.15.0', 'v26.4.0']) assert.equal(run(CLI, ['node-supported', v, range]).status, 0, v);
  for (const v of ['v22.22.1', 'v23.0.0', 'v24.14.0', 'v25.0.0', 'not-a-version']) assert.equal(run(CLI, ['node-supported', v, range]).status, 1, v);
});

test('cli.mjs version-ge exits 0 when the version meets the floor and 1 otherwise', () => {
  assert.equal(run(CLI, ['version-ge', 'v22.6.0', '22.6.0']).status, 0);
  assert.equal(run(CLI, ['version-ge', 'v20.19.0', '22.6.0']).status, 1);
});

test('cli.mjs same-path compares normalized and real paths, existing or not', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'a'));
  fs.symlinkSync(path.join(d, 'a'), path.join(d, 'link'));
  assert.equal(run(CLI, ['same-path', path.join(d, 'a'), path.join(d, 'x', '..', 'a')]).status, 0);
  assert.equal(run(CLI, ['same-path', path.join(d, 'a'), path.join(d, 'link')]).status, 0);
  assert.equal(run(CLI, ['same-path', path.join(d, 'nope'), path.join(d, 'nope')]).status, 0);
  assert.equal(run(CLI, ['same-path', path.join(d, 'a'), path.join(d, 'b')]).status, 1);
});

test('cli.mjs same-path resolves symlinks in the deepest existing ancestor of a path that does not exist yet', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'real'));
  fs.symlinkSync(path.join(d, 'real'), path.join(d, 'link'));
  assert.equal(run(CLI, ['same-path', path.join(d, 'link', 'new', 'deeper'), path.join(d, 'real', 'new', 'deeper')]).status, 0);
  assert.equal(run(CLI, ['same-path', path.join(d, 'link', 'new'), path.join(d, 'real', 'other')]).status, 1);
  assert.equal(run(CLI, ['same-path', path.join(d, 'link', 'a', '..', 'new'), path.join(d, 'real', 'new')]).status, 0);
});

const PROJECTS_LIB = path.join(HERE, '..', '..', 'projects', 'lib.mjs');
const RULE_TEMPLATE = path.join(HERE, '..', 'templates', '_custom-projects.md');
const CUSTOM_TEMPLATE = path.join(HERE, '..', 'templates', '_custom.md');

test('projects-rule appends the shipped projects block to modes/_custom.md exactly once', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  assert.equal(seed(['projects-rule', '--data', data, '--template', RULE_TEMPLATE]).stdout.trim(), 'absent');
  assert.equal(seed(['custom-template', '--data', data, '--template', CUSTOM_TEMPLATE]).stdout.trim(), 'created');
  assert.equal(seed(['projects-rule', '--data', data, '--template', RULE_TEMPLATE]).stdout.trim(), 'added');
  const file = path.join(data, 'modes', '_custom.md');
  const text = fs.readFileSync(file, 'utf8');
  const rule = fs.readFileSync(RULE_TEMPLATE, 'utf8').trimEnd();
  assert.equal(text.split(rule).length - 1, 1, 'the block appears once, verbatim');
  assert.ok(!text.includes('(none yet -- add yours above)\n\n## Custom Workflows'), 'the placeholder line was replaced');
  assert.ok(text.indexOf(rule) > text.indexOf('## House Rules') && text.indexOf(rule) < text.indexOf('## Custom Workflows'));
  assert.equal(seed(['projects-rule', '--data', data, '--template', RULE_TEMPLATE]).stdout.trim(), 'present');
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('projects-check accepts a valid library or projects JSON and rejects an invalid one with exit 2', () => {
  const d = tmp();
  const good = put(path.join(d, 'lib.md'), '# Projects library\n\n## Kite Tracker -- https://example.org/kites\n- Tracked kites.\n');
  const json = put(path.join(d, 'projects.json'), JSON.stringify([{ name: 'Kite Tracker', description: 'Tracked kites.', highlights: [] }]));
  const bad = put(path.join(d, 'bad.md'), '## Empty\nTags: go\n');
  const notList = put(path.join(d, 'bad.json'), '{"basics":{}}');
  for (const f of [good, json]) {
    const r = seed(['projects-check', '--lib', PROJECTS_LIB, '--file', f]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'ok\t1');
  }
  const r = seed(['projects-check', '--lib', PROJECTS_LIB, '--file', bad]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /"Empty".*no copy-paste points/);
  assert.equal(seed(['projects-check', '--lib', PROJECTS_LIB, '--file', notList]).status, 2);
});

test('projects-seed keeps a projects JSON under documents/projects as the Markdown intake reads, names it as each entry\'s Source, and creates article-digest.md only when absent', async () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const json = put(path.join(d, 'src', 'projects.json'), JSON.stringify([{ name: 'Kite Tracker', url: 'https://example.org/kites', description: 'Tracked kites.', highlights: ['Plotted paths.'], keywords: ['python'] }]));
  const r = seed(['projects-seed', '--lib', PROJECTS_LIB, '--data', data, '--file', json]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), [`copied\tprojects\t${path.join(data, 'documents/projects/projects.md')}`, 'created']);
  assert.deepEqual(fs.readdirSync(path.join(data, 'documents/projects')), ['projects.md']);
  assert.equal(fs.readFileSync(path.join(data, 'documents/projects/projects.md'), 'utf8'), '# Projects library\n\n## Kite Tracker -- https://example.org/kites\nTags: python\n- Tracked kites.\n- Plotted paths.\n');
  const { classifySource } = await import(pathToFileURL(path.join(HERE, '..', '..', '..', 'intake.mjs')).href);
  assert.equal(classifySource('projects/projects.md').kind, 'direct', 'intake can read the kept source');
  assert.equal(fs.readFileSync(path.join(data, 'article-digest.md'), 'utf8'), '# Projects library\n\n## Kite Tracker -- https://example.org/kites\nTags: python\nSource: documents/projects/projects.md\n- Tracked kites.\n- Plotted paths.\n');
  fs.writeFileSync(path.join(data, 'article-digest.md'), 'MINE\n');
  const again = seed(['projects-seed', '--lib', PROJECTS_LIB, '--data', data, '--file', json]);
  assert.deepEqual(again.stdout.trim().split('\n'), [`present\tprojects\t${path.join(data, 'documents/projects/projects.md')}`, 'exists']);
  assert.equal(fs.readFileSync(path.join(data, 'article-digest.md'), 'utf8'), 'MINE\n');
});

test('projects-seed writes a markdown library byte for byte', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const text = '# My projects\n\n## Kite Tracker\n\n**Hero metrics:** 40 kites\n\n**Proof points:**\n- Tracked kites.\n';
  const lib = put(path.join(d, 'src', 'lib.md'), text);
  assert.equal(seed(['projects-seed', '--lib', PROJECTS_LIB, '--data', data, '--file', lib]).status, 0);
  assert.equal(fs.readFileSync(path.join(data, 'article-digest.md'), 'utf8'), text);
});

test('projects-check and projects-seed refuse bytes that are not UTF-8 instead of decoding them leniently', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const bad = put(path.join(d, 'bad.md'), Buffer.from('## A\n- \xff\n', 'latin1'));
  for (const args of [['projects-check', '--lib', PROJECTS_LIB, '--file', bad], ['projects-seed', '--lib', PROJECTS_LIB, '--data', data, '--file', bad]]) {
    const r = seed(args);
    assert.equal(r.status, 2, args[0]);
    assert.match(r.stderr, /not valid UTF-8/, args[0]);
  }
  assert.equal(fs.existsSync(path.join(data, 'article-digest.md')), false);
});

test('cli.mjs same-path treats one folder spelled in two letter cases as the same path (SW4-tests-28)', (t) => {
  const h = caseFlippedHome();
  if (!h) return t.skip('needs a case-insensitive temp folder (macOS)');
  try {
    fs.mkdirSync(path.join(h.home, 'career-data'));
    assert.equal(run(CLI, ['same-path', path.join(h.home, 'career-data'), path.join(h.flipped, 'Career-Data')]).status, 0);
    assert.equal(run(CLI, ['same-path', path.join(h.home, 'career-data'), path.join(h.home, 'career-data-2')]).status, 1);
  } finally {
    h.cleanup();
  }
});

// Preloaded into the seed process so a write, or the rename or link that moves the temp file into place, fails the
// way a full volume makes it fail.
const failingFs = (dir, which) => put(path.join(dir, 'fail-fs.mjs'), `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
for (const name of ${JSON.stringify(which === 'renameSync' ? ['renameSync', 'linkSync'] : [which])}) {
  const real = fs[name];
  fs[name] = (...args) => {
    if (String(args[0]).includes('.tmp-')) {
      if (name === 'writeFileSync') real('' + args[0], String(args[1]).slice(0, 3), args[2]);
      const err = new Error('ENOSPC: no space left on device'); err.code = 'ENOSPC'; throw err;
    }
    return real(...args);
  };
}
syncBuiltinESMExports();
`);
const seedWith = (preload, args) => runNode(['--import', pathToFileURL(preload).href, SEED, ...args]);

for (const which of ['writeFileSync', 'renameSync']) {
  test(`given the volume fills during ${which}, when cv-write --replace runs, then it fails, keeps cv.md, and leaves no temp file or stray backup (R27-scripts-b-L1-02)`, () => {
    const d = tmp();
    const data = path.join(d, 'data');
    const r = put(path.join(d, 'resume.md'), '# New resume with personal data\n');
    put(path.join(data, 'cv.md'), 'OLD\n');
    const res = seedWith(failingFs(d, which), ['cv-write', '--data', data, '--resume', r, '--replace']);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /no space left/);
    assert.equal(fs.readFileSync(path.join(data, 'cv.md'), 'utf8'), 'OLD\n');
    assert.deepEqual(fs.readdirSync(data), ['cv.md'], 'neither the temp copy nor a backup of the untouched cv.md is left');
  });

  test(`given the volume fills during ${which}, when cv-write seeds an absent cv.md, then it fails and leaves no cv.md or temp file, so a re-run seeds it again (R27-scripts-b-L1-02 review)`, () => {
    const d = tmp();
    const data = path.join(d, 'data');
    const r = put(path.join(d, 'resume.md'), '# New resume with personal data\n');
    const res = seedWith(failingFs(d, which), ['cv-write', '--data', data, '--resume', r]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /no space left/);
    assert.deepEqual(fs.readdirSync(data), []);
    assert.equal(seed(['cv-write', '--data', data, '--resume', r]).stdout.trim(), 'created');
  });

  test(`given the volume fills during ${which}, when projects-rule runs, then it fails, keeps _custom.md, and leaves no temp file (R27-scripts-b-L1-02)`, () => {
    const d = tmp();
    const data = path.join(d, 'data');
    assert.equal(seed(['custom-template', '--data', data, '--template', CUSTOM_TEMPLATE]).stdout.trim(), 'created');
    const before = fs.readFileSync(path.join(data, 'modes', '_custom.md'), 'utf8');
    const res = seedWith(failingFs(d, which), ['projects-rule', '--data', data, '--template', RULE_TEMPLATE]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /no space left/);
    assert.equal(fs.readFileSync(path.join(data, 'modes', '_custom.md'), 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.join(data, 'modes')), ['_custom.md']);
  });
}

// Preloaded into the seed process: linkSync on the temp file fails the way a volume without hard links makes it fail,
// optionally after another writer creates the target, or the temp file cannot be removed once it is linked.
const linkFs = (dir, mode) => put(path.join(dir, 'link-fs.mjs'), `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realLink = fs.linkSync, realRm = fs.rmSync;
const tmpFile = (p) => String(p).includes('.tmp-');
fs.linkSync = (...args) => {
  if (${JSON.stringify(mode)} === 'rm-fails' || !tmpFile(args[0])) return realLink(...args);
  if (${JSON.stringify(mode)} === 'eperm-raced') fs.writeFileSync(args[1], 'THEIRS\\n');
  const err = new Error('EPERM: operation not permitted, link'); err.code = 'EPERM'; throw err;
};
fs.rmSync = (...args) => {
  if (${JSON.stringify(mode)} === 'rm-fails' && tmpFile(args[0])) { const err = new Error('EBUSY: resource busy'); err.code = 'EBUSY'; throw err; }
  return realRm(...args);
};
syncBuiltinESMExports();
`);

test('given the volume refuses hard links, when cv-write seeds an absent cv.md, then it renames the temp file into place (R27 merge review)', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const r = put(path.join(d, 'resume.md'), '# New resume\n');
  const res = seedWith(linkFs(d, 'eperm'), ['cv-write', '--data', data, '--resume', r]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'created');
  assert.equal(fs.readFileSync(path.join(data, 'cv.md'), 'utf8'), '# New resume\n');
  assert.deepEqual(fs.readdirSync(data), ['cv.md']);
});

test('given the volume refuses hard links and cv.md appears meanwhile, when cv-write seeds it, then it fails and keeps the other writer\'s cv.md (R27 merge review)', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const r = put(path.join(d, 'resume.md'), '# New resume\n');
  const res = seedWith(linkFs(d, 'eperm-raced'), ['cv-write', '--data', data, '--resume', r]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /appeared while it was being written/);
  assert.equal(fs.readFileSync(path.join(data, 'cv.md'), 'utf8'), 'THEIRS\n');
  assert.deepEqual(fs.readdirSync(data), ['cv.md'], 'no temp file is left');
});

test('given the temp file cannot be removed once linked, when cv-write seeds an absent cv.md, then it still reports the write that happened (R27 merge review)', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const r = put(path.join(d, 'resume.md'), '# New resume\n');
  const res = seedWith(linkFs(d, 'rm-fails'), ['cv-write', '--data', data, '--resume', r]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'created');
  assert.equal(fs.readFileSync(path.join(data, 'cv.md'), 'utf8'), '# New resume\n');
  const left = fs.readdirSync(data).filter((f) => f.includes('.tmp-'));
  assert.equal(left.length, 1);
  assert.match(res.stderr, new RegExp(`warning: could not remove ${path.join(data, left[0]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*delete it`), 'the leftover copy of cv.md is named, not left silently');
});

test('given the volume refuses hard links and cv.md is a dangling symlink, when cv-write seeds it, then it refuses as the link path does and keeps the symlink (R27 merge review)', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  fs.mkdirSync(data);
  fs.symlinkSync(path.join(d, 'nowhere.md'), path.join(data, 'cv.md'));
  const r = put(path.join(d, 'resume.md'), '# New resume\n');
  const res = seedWith(linkFs(d, 'eperm'), ['cv-write', '--data', data, '--resume', r]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /appeared while it was being written/);
  assert.equal(fs.readlinkSync(path.join(data, 'cv.md')), path.join(d, 'nowhere.md'));
  assert.deepEqual(fs.readdirSync(data), ['cv.md'], 'no temp file is left');
});

test('given the volume fills and the partial temp file cannot be removed, when cv-write runs, then it reports the full volume, not the cleanup (R27 merge review)', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const r = put(path.join(d, 'resume.md'), '# New resume\n');
  const preload = put(path.join(d, 'full-busy.mjs'), `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realWrite = fs.writeFileSync, realRm = fs.rmSync;
fs.writeFileSync = (...args) => {
  if (!String(args[0]).includes('.tmp-')) return realWrite(...args);
  realWrite(args[0], String(args[1]).slice(0, 3), args[2]);
  const err = new Error('ENOSPC: no space left on device'); err.code = 'ENOSPC'; throw err;
};
fs.rmSync = (...args) => {
  if (String(args[0]).includes('.tmp-')) { const err = new Error('EBUSY: resource busy'); err.code = 'EBUSY'; throw err; }
  return realRm(...args);
};
syncBuiltinESMExports();
`);
  const res = seedWith(preload, ['cv-write', '--data', data, '--resume', r]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no space left/);
  assert.doesNotMatch(res.stderr, /EBUSY/);
});

test('given the volume refuses hard links and cv.md appears just before the temp file is published, when cv-write seeds it, then the other writer\'s cv.md is kept (R27 merge review)', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const r = put(path.join(d, 'resume.md'), '# New resume\n');
  const preload = put(path.join(d, 'late-race.mjs'), `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realLink = fs.linkSync, realRename = fs.renameSync, realCopy = fs.copyFileSync;
fs.linkSync = (...args) => {
  if (!String(args[0]).includes('.tmp-')) return realLink(...args);
  const err = new Error('EPERM: operation not permitted, link'); err.code = 'EPERM'; throw err;
};
// Whatever moves the temp file to cv.md, another writer gets there first, after every check was made.
const racing = (real) => (...args) => {
  if (String(args[0]).includes('.tmp-') && String(args[1]).endsWith('cv.md')) fs.writeFileSync(args[1], 'THEIRS\\n');
  return real(...args);
};
fs.renameSync = racing(realRename);
fs.copyFileSync = racing(realCopy);
const realOpen = fs.openSync;
fs.openSync = (...args) => {
  if (String(args[0]).endsWith('cv.md') && args[1] === 'wx') fs.writeFileSync(args[0], 'THEIRS\\n');
  return realOpen(...args);
};
syncBuiltinESMExports();
`);
  const res = seedWith(preload, ['cv-write', '--data', data, '--resume', r]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /appeared while it was being written/);
  assert.equal(fs.readFileSync(path.join(data, 'cv.md'), 'utf8'), 'THEIRS\n');
  assert.deepEqual(fs.readdirSync(data), ['cv.md'], 'no temp file is left');
});

test('given the replace fails and the backup it made cannot be removed, when cv-write --replace runs, then it reports the write failure, not the cleanup (R27 merge review)', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const r = put(path.join(d, 'resume.md'), '# New resume\n');
  put(path.join(data, 'cv.md'), 'OLD\n');
  const preload = put(path.join(d, 'busy-backup.mjs'), `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realRename = fs.renameSync, realRm = fs.rmSync;
fs.renameSync = (...args) => {
  if (String(args[0]).includes('.tmp-')) { const err = new Error('ENOSPC: no space left on device'); err.code = 'ENOSPC'; throw err; }
  return realRename(...args);
};
fs.rmSync = (...args) => {
  if (String(args[0]).includes('.bak-')) { const err = new Error('EBUSY: resource busy'); err.code = 'EBUSY'; throw err; }
  return realRm(...args);
};
syncBuiltinESMExports();
`);
  const res = seedWith(preload, ['cv-write', '--data', data, '--resume', r, '--replace']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no space left/);
  assert.doesNotMatch(res.stderr, /EBUSY/);
  assert.equal(fs.readFileSync(path.join(data, 'cv.md'), 'utf8'), 'OLD\n');
});

test('given the volume refuses hard links and creating cv.md fails while another writer creates it, when cv-write seeds it, then the other writer\'s cv.md is kept (R27 merge review)', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const r = put(path.join(d, 'resume.md'), '# New resume\n');
  const preload = put(path.join(d, 'open-race.mjs'), `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realLink = fs.linkSync, realCopy = fs.copyFileSync, realOpen = fs.openSync;
fs.linkSync = (...args) => {
  if (!String(args[0]).includes('.tmp-')) return realLink(...args);
  const err = new Error('EPERM: operation not permitted, link'); err.code = 'EPERM'; throw err;
};
// Creating cv.md fails before it is created (EACCES at open), and another writer creates it right then.
const denied = (target) => {
  fs.writeFileSync(target, 'THEIRS\\n');
  const err = new Error('EACCES: permission denied, open'); err.code = 'EACCES'; throw err;
};
fs.copyFileSync = (...args) => (String(args[1]).endsWith('cv.md') ? denied(args[1]) : realCopy(...args));
fs.openSync = (...args) => (String(args[0]).endsWith('cv.md') && args[1] === 'wx' ? denied(args[0]) : realOpen(...args));
syncBuiltinESMExports();
`);
  const res = seedWith(preload, ['cv-write', '--data', data, '--resume', r]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /permission denied/);
  assert.equal(fs.readFileSync(path.join(data, 'cv.md'), 'utf8'), 'THEIRS\n');
});

// Preloaded into the seed process: every write or copy to a file whose name contains `name` (the target or its temp
// file) puts part of its bytes there, then fails the way a full volume makes it fail.
const partialWrites = (dir, name) => put(path.join(dir, 'partial-writes.mjs'), `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realWrite = fs.writeFileSync;
const full = () => { const err = new Error('ENOSPC: no space left on device'); err.code = 'ENOSPC'; return err; };
const hit = (file) => typeof file === 'string' && file.includes(${JSON.stringify(name)});
fs.writeFileSync = (file, data, ...rest) => {
  if (!hit(file)) return realWrite(file, data, ...rest);
  realWrite(file, String(data).slice(0, 3), ...rest);
  throw full();
};
const realAppend = fs.appendFileSync;
fs.appendFileSync = (file, data, ...rest) => {
  if (!hit(file)) return realAppend(file, data, ...rest);
  realAppend(file, String(data).slice(0, 3), ...rest);
  throw full();
};
const realOpen = fs.openSync;
const realWriteFd = fs.writeSync;
const hitFds = new Set();
fs.openSync = (file, ...rest) => { const fd = realOpen(file, ...rest); if (hit(file)) hitFds.add(fd); return fd; };
// As write(2) on a filling volume: a short write returns its count, and the next write fails.
const shortWritten = new Set();
fs.writeSync = (fd, data, ...rest) => {
  if (!hitFds.has(fd)) return realWriteFd(fd, data, ...rest);
  if (shortWritten.has(fd)) throw full();
  shortWritten.add(fd);
  return realWriteFd(fd, Buffer.from(data).subarray(0, 3));
};
const realCopy = fs.copyFileSync;
fs.copyFileSync = (src, dest, ...rest) => {
  if (!hit(dest)) return realCopy(src, dest, ...rest);
  realWrite(dest, fs.readFileSync(src, 'utf8').slice(0, 3), { flag: 'wx' });
  throw full();
};
syncBuiltinESMExports();
`);

test('given a local-paths.txt with user lines, when the volume fills while local-paths adds custom/, then the user lines are kept and no temp file is left (R28-scripts-b-L1-01)', () => {
  const d = tmp();
  const f = put(path.join(d, 'config', 'local-paths.txt'), 'my-notes/\nmy-drafts/\n');
  const res = seedWith(partialWrites(d, 'local-paths.txt'), ['local-paths', '--dir', d]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no space left/);
  assert.equal(fs.readFileSync(f, 'utf8'), 'my-notes/\nmy-drafts/\n');
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['local-paths.txt']);
});

test('given a local-paths.txt another installer appends to, when the volume fills while local-paths adds custom/, then only the partial custom/ is cut back and the other entry stays (R28-scr-rev-01)', () => {
  const d = tmp();
  const f = put(path.join(d, 'config', 'local-paths.txt'), 'my-notes/\n');
  // Another installer appends its entry after this one read the file, then this one's append fills the volume.
  const preload = put(path.join(d, 'race.mjs'), `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const file = ${JSON.stringify(f)};
const full = () => { const err = new Error('ENOSPC: no space left on device'); err.code = 'ENOSPC'; return err; };
const realOpen = fs.openSync;
const realWrite = fs.writeSync;
const realAppend = fs.appendFileSync;
const fds = new Set();
let writes = 0;
fs.openSync = (p, ...rest) => { const fd = realOpen(p, ...rest); if (p === file) fds.add(fd); return fd; };
// A short write returns its count and the next write fails, as write(2) does on a filling volume.
fs.writeSync = (fd, data, ...rest) => {
  if (!fds.has(fd)) return realWrite(fd, data, ...rest);
  if (writes++ > 0) throw full();
  realAppend(file, 'other/\\n');
  return realWrite(fd, Buffer.from(data).subarray(0, 3));
};
fs.appendFileSync = (p, data, ...rest) => {
  if (p === file) throw new Error('local-paths.txt must be appended through its open fd');
  return realAppend(p, data, ...rest);
};
syncBuiltinESMExports();
`);
  const res = seedWith(preload, ['local-paths', '--dir', d]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no space left/);
  assert.equal(fs.readFileSync(f, 'utf8'), 'my-notes/\nother/\n');
});

test('given another installer adds custom/ after local-paths reads the file, when local-paths opens it to append, then custom/ is not added twice (R28-scr-rev-01 review)', () => {
  const d = tmp();
  const f = put(path.join(d, 'config', 'local-paths.txt'), 'notes/\n');
  const preload = put(path.join(d, 'late-writer.mjs'), `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realOpen = fs.openSync;
fs.openSync = (p, ...rest) => {
  if (p === ${JSON.stringify(f)}) fs.appendFileSync(p, 'custom/\\n');
  return realOpen(p, ...rest);
};
syncBuiltinESMExports();
`);
  const res = seedWith(preload, ['local-paths', '--dir', d]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'present');
  assert.equal(fs.readFileSync(f, 'utf8'), 'notes/\ncustom/\n');
});

const seedAsync = (args, preload) => new Promise((resolve) => {
  const pre = preload ? ['--import', pathToFileURL(preload).href] : [];
  const child = spawn(process.execPath, [...pre, SEED, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

test('given another installer holding the local-paths.txt lock, when it adds custom/ and lets go, then local-paths waits and reports it present instead of adding it twice (R28-scr-rev-01 review 2)', async () => {
  const d = tmp();
  const f = put(path.join(d, 'config', 'local-paths.txt'), 'notes/\n');
  fs.mkdirSync(`${f}.lock`);
  // The child marks the moment it finds the lock taken, so the test lets go only once it is really waiting on it: a
  // seed slow to start (a loaded host) would otherwise first look after the lock is gone and pass without waiting.
  const seen = path.join(d, 'contended');
  const preload = put(path.join(d, 'contended.mjs'), `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realMkdir = fs.mkdirSync;
fs.mkdirSync = (p, ...rest) => {
  try {
    return realMkdir(p, ...rest);
  } catch (err) {
    if (err.code === 'EEXIST' && String(p) === ${JSON.stringify(`${f}.lock`)} && !fs.existsSync(${JSON.stringify(seen)})) fs.writeFileSync(${JSON.stringify(seen)}, '');
    throw err;
  }
};
syncBuiltinESMExports();
`);
  let finished = false;
  const run = seedAsync(['local-paths', '--dir', d], preload).then((r) => { finished = true; return r; });
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(seen) && !finished && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fs.existsSync(seen), `local-paths never found the lock taken: ${JSON.stringify(finished ? await run : 'still running')}`);
  assert.equal(finished, false, 'local-paths must still be waiting on the held lock');
  fs.appendFileSync(f, 'custom/\n');
  fs.rmdirSync(`${f}.lock`);
  const res = await run;
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'present');
  assert.equal(fs.readFileSync(f, 'utf8'), 'notes/\ncustom/\n');
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['local-paths.txt']);
});

test('given a local-paths.txt lock a crashed installer left long ago, when local-paths runs, then it breaks the lock and adds custom/ (R28-scr-rev-01 review 2)', () => {
  const d = tmp();
  const f = put(path.join(d, 'config', 'local-paths.txt'), 'notes/\n');
  fs.mkdirSync(`${f}.lock`);
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(`${f}.lock`, old, old);
  const res = seed(['local-paths', '--dir', d]);
  assert.equal(res.stdout.trim(), 'added', res.stderr);
  assert.equal(fs.readFileSync(f, 'utf8'), 'notes/\ncustom/\n');
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['local-paths.txt']);
});

test('given a stale local-paths.txt lock, when several installers find it at once, then only one breaks it and custom/ is added once (R28-scr-rev-01 review 3)', async () => {
  const d = tmp();
  const f = put(path.join(d, 'config', 'local-paths.txt'), 'notes/\n');
  fs.mkdirSync(`${f}.lock`);
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(`${f}.lock`, old, old);
  // Each installer waits at a barrier until all are started, so a slow boot cannot run them one after another.
  const go = path.join(d, 'go');
  const readyDir = path.join(d, 'ready');
  fs.mkdirSync(readyDir);
  // All installers read the old lock's age at once, but each acts on that stale verdict a little later than the one
  // before it, so the later ones find the fresh lock the first took after breaking the old one.
  const preload = put(path.join(d, 'slow-stat.mjs'), `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
fs.writeFileSync(${JSON.stringify(readyDir)} + '/ready-' + process.pid, '');
while (!fs.existsSync(${JSON.stringify(go)})) sleep(2);
let slot = 0;
for (;; slot++) {
  try {
    fs.mkdirSync(${JSON.stringify(d)} + '/slot-' + slot);
    break;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}
const realStat = fs.statSync;
let firstLook = true;
fs.statSync = (p, ...rest) => {
  const st = realStat(p, ...rest);
  if (String(p) === ${JSON.stringify(`${f}.lock`)} && firstLook) {
    firstLook = false;
    sleep(300 + slot * 200);
  }
  return st;
};
// And each holds the lock a while, reading the file, so a lock broken under its holder lets two read at once.
const realRead = fs.readFileSync;
fs.readFileSync = (p, ...rest) => {
  const text = realRead(p, ...rest);
  if (typeof p === 'number') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  return text;
};
syncBuiltinESMExports();
`);
  let exited = 0;
  const all = Promise.all(Array.from({ length: 4 }, () => seedAsync(['local-paths', '--dir', d], preload).then((r) => { exited++; return r; })));
  while (fs.readdirSync(readyDir).length < 4) {
    if (exited) {
      fs.writeFileSync(go, '');
      assert.fail(`an installer exited before it was ready: ${JSON.stringify(await all)}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  fs.writeFileSync(go, '');
  const runs = await all;
  for (const r of runs) assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(f, 'utf8'), 'notes/\ncustom/\n');
  assert.deepEqual(runs.map((r) => r.stdout.trim()).sort(), ['added', 'present', 'present', 'present']);
});

test('given its lock is broken and retaken by another installer while local-paths runs, when it finishes, then it leaves that installer\'s lock in place (R28-scr-rev-01 review 4)', () => {
  const d = tmp();
  const f = put(path.join(d, 'config', 'local-paths.txt'), 'notes/\n');
  const lock = `${f}.lock`;
  const preload = put(path.join(d, 'retaken.mjs'), `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realRead = fs.readFileSync;
fs.readFileSync = (p, ...rest) => {
  if (typeof p === 'number') {
    fs.rmSync(${JSON.stringify(lock)}, { recursive: true, force: true });
    fs.mkdirSync(${JSON.stringify(lock)});
  }
  return realRead(p, ...rest);
};
syncBuiltinESMExports();
`);
  const res = seedWith(preload, ['local-paths', '--dir', d]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(f, 'utf8'), 'notes/\ncustom/\n');
  assert.equal(fs.existsSync(lock), true, 'the other installer still holds its lock');
});

test('given local-paths.txt turns into a dangling symlink after local-paths resolves it, when it updates the file, then it fails naming the path instead of looping (R28-scr-rev-01 review 3)', () => {
  const d = tmp();
  const f = path.join(d, 'config', 'local-paths.txt');
  const preload = put(path.join(d, 'dangle.mjs'), `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realMkdir = fs.mkdirSync;
fs.mkdirSync = (p, ...rest) => {
  const r = realMkdir(p, ...rest);
  if (String(p) === ${JSON.stringify(`${f}.lock`)}) fs.symlinkSync('nowhere', ${JSON.stringify(f)});
  return r;
};
syncBuiltinESMExports();
`);
  const res = seedWith(preload, ['local-paths', '--dir', d]);
  assert.notEqual(res.status, null, 'local-paths did not finish');
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /local-paths\.txt/);
});

test('given no local-paths.txt, when another writer creates it just before local-paths publishes its own, then theirs is kept and custom/ is appended to it (R28-scr-rev-01 review 2)', () => {
  const d = tmp();
  const f = path.join(d, 'config', 'local-paths.txt');
  const preload = put(path.join(d, 'late-create.mjs'), `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const file = ${JSON.stringify(f)};
const theirs = () => fs.writeFileSync(file, 'theirs/\\n', { flag: 'wx' });
const realLink = fs.linkSync;
fs.linkSync = (src, dest) => { if (dest === file) theirs(); return realLink(src, dest); };
const realRename = fs.renameSync;
fs.renameSync = (src, dest) => { if (dest === file) theirs(); return realRename(src, dest); };
syncBuiltinESMExports();
`);
  const res = seedWith(preload, ['local-paths', '--dir', d]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'added');
  assert.equal(fs.readFileSync(f, 'utf8'), 'theirs/\ncustom/\n');
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['local-paths.txt']);
});

test('given no article-digest.md, when the volume fills while projects-seed writes it, then no partial article-digest.md is left for a re-run to keep (R28-scripts-b-L1-02)', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const lib = put(path.join(d, 'src', 'lib.md'), '# My projects\n\n## Kite Tracker\n\n**Proof points:**\n- Tracked kites.\n');
  const res = seedWith(partialWrites(d, 'article-digest.md'), ['projects-seed', '--lib', PROJECTS_LIB, '--data', data, '--file', lib]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no space left/);
  assert.deepEqual(fs.readdirSync(data).filter((n) => n.includes('article-digest')), []);
});

test('given no modes/_custom.md, when the volume fills while custom-template copies it, then no partial _custom.md is left for a re-run to keep (R28-scripts-b-L1-02)', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const t = put(path.join(d, 't.md'), 'TEMPLATE\n');
  const res = seedWith(partialWrites(d, '_custom.md'), ['custom-template', '--data', data, '--template', t]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no space left/);
  assert.deepEqual(fs.readdirSync(path.join(data, 'modes')), []);
});

test('given an existing modes/_custom.md, when custom-template runs, then it reports exists and leaves no temp file (R28-scripts-b-L1-02)', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const t = put(path.join(d, 't.md'), 'TEMPLATE\n');
  const target = put(path.join(data, 'modes', '_custom.md'), 'MINE\n');
  const res = seed(['custom-template', '--data', data, '--template', t]);
  assert.equal(res.stdout.trim(), 'exists', res.stderr);
  assert.equal(fs.readFileSync(target, 'utf8'), 'MINE\n');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['_custom.md']);
});

test('given a clock far from UTC, when cv-write --replace backs up cv.md, then the backup stamp is the local time, as the install log is dated (R28-scripts-b-L2-02)', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const r = put(path.join(d, 'resume.md'), '# New\n');
  put(path.join(data, 'cv.md'), 'OLD\n');
  // Etc/GMT-14 is UTC+14, so a UTC stamp is never inside the local window below.
  const local = (ms) => new Date(ms + 14 * 3600_000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  const before = local(Date.now() - 1000);
  const res = runNode([SEED, 'cv-write', '--data', data, '--resume', r, '--replace'], { stdio: 'pipe', env: { ...process.env, TZ: 'Etc/GMT-14' } });
  const after = local(Date.now() + 1000);
  const [kind, backup] = res.stdout.trim().split('\t');
  assert.equal(kind, 'replaced', res.stderr);
  const stamped = path.basename(backup).replace(/^cv\.md\.bak-/, '');
  assert.match(stamped, /^\d{8}T\d{6}$/);
  assert.ok(stamped >= before && stamped <= after, `backup stamp ${stamped} is not the local time (${before} to ${after})`);
});

test('given config/local-paths.txt is a symlink to a shared file, when local-paths adds custom/, then the shared file gets the line and the link is kept (R28-scripts-b-L1-01 review)', () => {
  const d = tmp();
  const shared = put(path.join(d, 'shared', 'local-paths.txt'), 'notes/\n');
  fs.mkdirSync(path.join(d, 'config'));
  const link = path.join(d, 'config', 'local-paths.txt');
  fs.symlinkSync(path.relative(path.dirname(link), shared), link);
  assert.equal(seed(['local-paths', '--dir', d]).stdout.trim(), 'added');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link was replaced by a regular file');
  assert.equal(fs.readFileSync(shared, 'utf8'), 'notes/\ncustom/\n');
  assert.deepEqual(fs.readdirSync(path.dirname(link)), ['local-paths.txt']);
});

test('given a temp file a crashed earlier seed left under this process id, when projects-seed creates article-digest.md, then it is created rather than reported as existing (R28-scripts-b-L1-02 review)', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const text = '# My projects\n\n## Kite Tracker\n\n**Proof points:**\n- Tracked kites.\n';
  const lib = put(path.join(d, 'src', 'lib.md'), text);
  fs.mkdirSync(data, { recursive: true });
  const stale = put(path.join(d, 'stale-tmp.mjs'), `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(data)} + '/.article-digest.md.tmp-' + process.pid, 'PARTIAL');
`);
  const res = seedWith(stale, ['projects-seed', '--lib', PROJECTS_LIB, '--data', data, '--file', lib]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim().split('\n').at(-1), 'created');
  assert.equal(fs.readFileSync(path.join(data, 'article-digest.md'), 'utf8'), text);
  const temps = fs.readdirSync(data).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(temps.map((n) => fs.readFileSync(path.join(data, n), 'utf8')), ['PARTIAL'], 'only the crashed run\'s temp file is left');
});

test('given a config/local-paths.txt the user cannot write, when local-paths runs, then it fails naming the file and leaves it as it was (R28-scripts-b-L1-01 review 3)', () => {
  const d = tmp();
  const f = put(path.join(d, 'config', 'local-paths.txt'), 'notes/\n');
  fs.chmodSync(f, 0o444);
  try {
    const res = seed(['local-paths', '--dir', d]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /local-paths\.txt/);
    assert.equal(fs.readFileSync(f, 'utf8'), 'notes/\n');
    assert.equal(fs.statSync(f).mode & 0o777, 0o444);
  } finally {
    fs.chmodSync(f, 0o644);
  }
});

test('given config/ the user cannot add files to, when local-paths adds custom/ to its writable local-paths.txt, then the line is added in the same file (R28-scripts-b-L1-01 review 4)', () => {
  const d = tmp();
  const f = put(path.join(d, 'config', 'local-paths.txt'), 'notes/\n');
  const ino = fs.statSync(f).ino;
  fs.chmodSync(path.dirname(f), 0o555);
  try {
    const res = seed(['local-paths', '--dir', d]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), 'added');
    assert.equal(fs.readFileSync(f, 'utf8'), 'notes/\ncustom/\n');
    assert.equal(fs.statSync(f).ino, ino);
  } finally {
    fs.chmodSync(path.dirname(f), 0o755);
  }
});

test('given config/local-paths.txt is hard-linked elsewhere, when local-paths adds custom/, then both names still show the same file (R28-scripts-b-L1-01 review 3)', () => {
  const d = tmp();
  const f = put(path.join(d, 'config', 'local-paths.txt'), 'notes/\n');
  const other = path.join(d, 'shared-paths.txt');
  fs.linkSync(f, other);
  assert.equal(seed(['local-paths', '--dir', d]).stdout.trim(), 'added');
  assert.equal(fs.readFileSync(other, 'utf8'), 'notes/\ncustom/\n');
  assert.equal(fs.statSync(f).ino, fs.statSync(other).ino);
});

test('given config/ is a directory symlink and local-paths.txt links upward from it, when local-paths adds custom/, then the file the kernel resolves gets the line (R28-scripts-b-L1-01 review 3)', () => {
  const d = tmp();
  const checkout = path.join(d, 'checkout');
  const real = path.join(d, 'elsewhere', 'config');
  const shared = put(path.join(d, 'elsewhere', 'shared', 'paths.txt'), 'notes/\n');
  fs.mkdirSync(real, { recursive: true });
  fs.mkdirSync(checkout);
  fs.symlinkSync(real, path.join(checkout, 'config'));
  fs.symlinkSync('../shared/paths.txt', path.join(real, 'local-paths.txt'));
  assert.equal(seed(['local-paths', '--dir', checkout]).stdout.trim(), 'added');
  assert.equal(fs.readFileSync(shared, 'utf8'), 'notes/\ncustom/\n');
  assert.equal(fs.existsSync(path.join(checkout, 'shared')), false);
  assert.ok(fs.lstatSync(path.join(real, 'local-paths.txt')).isSymbolicLink());
});

test('given a private config/local-paths.txt, when local-paths writes the merged text, then its temp file is never readable by others (R28-scripts-b-L1-01 review 2)', () => {
  const d = tmp();
  const f = put(path.join(d, 'config', 'local-paths.txt'), 'notes/\n');
  fs.chmodSync(f, 0o600);
  const seen = path.join(d, 'temp-mode.txt');
  const preload = put(path.join(d, 'temp-mode.mjs'), `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realWrite = fs.writeFileSync;
fs.writeFileSync = (...args) => {
  const r = realWrite(...args);
  if (String(args[0]).includes('.tmp-')) realWrite(${JSON.stringify(seen)}, (fs.statSync(args[0]).mode & 0o777).toString(8));
  return r;
};
syncBuiltinESMExports();
`);
  const res = seedWith(preload, ['local-paths', '--dir', d]);
  assert.equal(res.status, 0, res.stderr);
  // The line is appended in place, so no temp file is ever written to be read by others.
  assert.equal(fs.existsSync(seen), false);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test('given a private config/local-paths.txt, when local-paths adds custom/, then the file keeps its permissions (R28-scripts-b-L1-01 review)', () => {
  const d = tmp();
  const f = put(path.join(d, 'config', 'local-paths.txt'), 'notes/\n');
  fs.chmodSync(f, 0o600);
  assert.equal(seed(['local-paths', '--dir', d]).stdout.trim(), 'added');
  assert.equal(fs.readFileSync(f, 'utf8'), 'notes/\ncustom/\n');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

// projects-rule and cv-write --replace swap in a new copy, which must land at the file a symlink points to and keep the
// user's mode, as local-paths keeps them (R29-scripts-b-L2-02).
test('given modes/_custom.md is a symlink to a dotfiles copy, when projects-rule adds the rule, then the dotfiles copy gets it and the link is kept (R29-scripts-b-L2-02)', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const shared = put(path.join(d, 'dotfiles', '_custom.md'), fs.readFileSync(CUSTOM_TEMPLATE, 'utf8'));
  fs.chmodSync(shared, 0o600);
  const link = path.join(data, 'modes', '_custom.md');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(link), shared), link);
  assert.equal(seed(['projects-rule', '--data', data, '--template', RULE_TEMPLATE]).stdout.trim(), 'added');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link was replaced by a regular file');
  assert.ok(fs.readFileSync(shared, 'utf8').includes(fs.readFileSync(RULE_TEMPLATE, 'utf8').trimEnd()));
  assert.equal(fs.statSync(shared).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(link)), ['_custom.md']);
  assert.deepEqual(fs.readdirSync(path.dirname(shared)), ['_custom.md']);
});

test('given a private (0600) modes/_custom.md, when projects-rule adds the rule, then the file stays 0600 (R29-scripts-b-L2-02)', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const file = put(path.join(data, 'modes', '_custom.md'), fs.readFileSync(CUSTOM_TEMPLATE, 'utf8'));
  fs.chmodSync(file, 0o600);
  assert.equal(seed(['projects-rule', '--data', data, '--template', RULE_TEMPLATE]).stdout.trim(), 'added');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('given a private (0600) cv.md behind a symlink, when cv-write --replace replaces it, then the linked file gets the resume, keeps 0600 and the link is kept (R29-scripts-b-L2-02)', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const real = put(path.join(d, 'dotfiles', 'cv.md'), '# Old\n');
  fs.chmodSync(real, 0o600);
  const link = path.join(data, 'cv.md');
  fs.mkdirSync(data, { recursive: true });
  fs.symlinkSync(real, link);
  const r = put(path.join(d, 'new.md'), '# New\n');
  const res = seed(['cv-write', '--data', data, '--resume', r, '--replace']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.split('\t')[0], 'replaced');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link was replaced by a regular file');
  assert.equal(fs.readFileSync(real, 'utf8'), '# New\n');
  assert.equal(fs.statSync(real).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(real)), ['cv.md']);
  const backup = res.stdout.trim().split('\t')[1];
  assert.equal(fs.readFileSync(backup, 'utf8'), '# Old\n');
});

test('given a private (0600) cv.md, when cv-write --replace replaces it, then it stays 0600 (R29-scripts-b-L2-02)', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const cv = put(path.join(data, 'cv.md'), '# Old\n');
  fs.chmodSync(cv, 0o600);
  const r = put(path.join(d, 'new.md'), '# New\n');
  assert.equal(seed(['cv-write', '--data', data, '--resume', r, '--replace']).status, 0);
  assert.equal(fs.readFileSync(cv, 'utf8'), '# New\n');
  assert.equal(fs.statSync(cv).mode & 0o777, 0o600);
});

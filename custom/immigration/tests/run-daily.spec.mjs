import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const RUN_DAILY = path.join(HERE, '..', 'run-daily.sh');

/** The node -e program run-daily.sh fills the policy prompt with, run as the script runs it (cwd = the checkout). */
function fillPrompt(env) {
  const script = readFileSync(RUN_DAILY, 'utf8');
  const src = script.match(/prompt="\$\(WATCH_JSON=.*? node -e '([\s\S]*?)'\)"/)?.[1];
  assert.ok(src, 'the prompt-filling node -e program was not found in run-daily.sh');
  const r = spawnSync(process.execPath, ['-e', src], { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('the policy prompt carries the watch JSON, the date and the data dir verbatim, even when they hold $ replacement patterns', () => {
  const watch = '{"items":[{"title":"Fee rises to $& and $$5 ($` then $\')"}]}';
  const imm = '/data/$&root/data/immigration';
  const out = fillPrompt({ WATCH_JSON: watch, TODAY: '2026-10-04', IMM: imm });
  assert.ok(out.includes(watch), out.slice(0, 2000));
  assert.ok(out.includes(`\`${imm}/policy-changes.tsv\``));
  assert.ok(out.includes('Today is 2026-10-04.'));
  assert.equal(out.includes('{{'), false, 'every placeholder is filled');
});

// ---- the policy pass runs confined, like a Control Center session ----

const CONFINEMENT = path.join(ROOT, 'custom/control-center/server/claude/confinement.mjs');

/**
 * A checkout with the real run-daily.sh, daily-prompt.md, path-resolver.mjs and confinement module and stubs for every
 * other step, a data root outside it, a fake Keychain and a fake claude that records its argv and the settings file it
 * was given. CC_CLAUDE_BIN points at the fake: the real claude on this machine is never run.
 */
function dailyWorld({ dataInside = false, homeIsData = false } = {}) {
  const T = fs.realpathSync(tempDir('run-daily-'));
  const root = path.join(T, 'root');
  const home = path.join(T, 'home');
  const data = homeIsData ? home : dataInside ? root : path.join(T, 'data');
  const bin = path.join(T, 'bin');
  const tmp = path.join(T, 'tmp');
  for (const d of [root, data, home, bin, tmp, path.join(data, 'config')]) fs.mkdirSync(d, { recursive: true });
  const put = (rel, text, mode = 0o644) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text, { mode });
  };
  for (const rel of ['custom/immigration/run-daily.sh', 'custom/immigration/daily-prompt.md', 'path-resolver.mjs']) put(rel, readFileSync(path.join(ROOT, rel), 'utf8'), 0o755);
  put('custom/control-center/server/claude/confinement.mjs', readFileSync(CONFINEMENT, 'utf8'));
  const stepLog = path.join(T, 'steps.log');
  const stub = (name) => `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(stepLog)}, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\n`;
  put('custom/immigration/watch.mjs', `${stub('watch')}if (!process.argv.includes('--ack')) process.stdout.write(JSON.stringify({ new_items: [] }));\n`);
  for (const rel of ['scan.mjs', 'rank-pipeline.mjs', 'custom/pipeline/prioritize.mjs', 'custom/pipeline/shortlist.mjs']) put(rel, stub(rel));
  fs.writeFileSync(path.join(data, 'config/profile.yml'), 'location:\n  needs_sponsorship: true\n');
  fs.writeFileSync(path.join(bin, 'security'), '#!/bin/bash\necho fake-keychain-token\n', { mode: 0o755 });
  const record = path.join(T, 'claude-calls.ndjson');
  const fakeClaude = path.join(bin, 'fake-claude');
  fs.writeFileSync(
    fakeClaude,
    `#!${process.execPath}\nconst fs = require('fs');\nconst argv = process.argv.slice(2);\nconst at = argv.indexOf('--settings');\nconst settings = at === -1 ? null : JSON.parse(fs.readFileSync(argv[at + 1], 'utf8'));\nfs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, cwd: process.cwd(), settings, token: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) }) + '\\n');\nconsole.log('SUMMARY: 0 policy changes, 0 company alerts');\n`,
    { mode: 0o755 },
  );
  const run = () => {
    // Never the real claude: the script must take CC_CLAUDE_BIN, or it would run the one on this machine.
    assert.match(readFileSync(path.join(root, 'custom/immigration/run-daily.sh'), 'utf8'), /\$\{CC_CLAUDE_BIN:-claude\}/, 'run-daily.sh must run claude through CC_CLAUDE_BIN');
    const env = { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: tmp, CAREER_OPS_ROOT: data, CC_CLAUDE_BIN: fakeClaude };
    const r = spawnSync('/bin/bash', [path.join(root, 'custom/immigration/run-daily.sh')], { env, encoding: 'utf8', timeout: 60_000 });
    const imm = path.join(data, 'data', 'immigration');
    const logs = fs.existsSync(path.join(imm, 'logs')) ? fs.readdirSync(path.join(imm, 'logs')).filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)) : [];
    const log = logs.map((f) => readFileSync(path.join(imm, 'logs', f), 'utf8')).join('\n');
    const calls = fs.existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const steps = fs.existsSync(stepLog) ? readFileSync(stepLog, 'utf8') : '';
    return { status: r.status, log, calls, steps, imm, leftovers: fs.readdirSync(tmp) };
  };
  return { T, root, data, home, run };
}

const flagValue = (argv, flag) => argv[argv.indexOf(flag) + 1];

test('the policy pass runs claude --restricted with an exact tool list, no MCP servers and a settings file, never a bare Read or Bash', async () => {
  const { HOME_READ_DENY } = await import(CONFINEMENT);
  const w = dailyWorld();
  const r = w.run();
  assert.equal(r.status, 0, r.log);
  assert.equal(r.calls.length, 1, r.log);
  const { argv, cwd, token } = r.calls[0];
  assert.equal(argv[0], '-p');
  for (const flag of ['--restricted', '--strict-mcp-config']) assert.ok(argv.includes(flag), `${flag} missing from ${argv.join(' ')}`);
  assert.equal(flagValue(argv, '--tools'), 'Read,Edit,Write,WebFetch,WebSearch');
  assert.equal(flagValue(argv, '--permission-mode'), 'dontAsk');
  assert.deepEqual(flagValue(argv, '--disallowedTools').split(','), ['Bash', 'Agent', 'Task', 'NotebookEdit', 'PowerShell']);
  assert.equal(argv.includes('--allowedTools'), false, 'the rules live in the settings file, not in argv');
  assert.equal(argv.includes('--add-dir'), false);
  assert.equal(argv.includes('Read'), false);
  assert.equal(cwd, w.root);
  assert.equal(token, true, 'the pass still runs on the Keychain token');
  // The settings file lives only for the pass.
  assert.deepEqual(r.leftovers, []);
  assert.match(r.steps, /^watch --ack /m, 'a successful pass acknowledges its batch');
  assert.ok(HOME_READ_DENY.length > 10);
});

test('the settings allow reads only of the immigration folder and the profile, writes only to the immigration folder, and deny the home credential stores and secret files', async () => {
  const { HOME_READ_DENY, READ_DENY } = await import(CONFINEMENT);
  const w = dailyWorld();
  const r = w.run();
  assert.equal(r.status, 0, r.log);
  const { permissions } = r.calls[0].settings;
  const imm = path.join(w.data, 'data', 'immigration');
  assert.deepEqual(permissions.additionalDirectories, [w.data]);
  assert.deepEqual(
    [...permissions.allow].sort(),
    ['WebFetch', 'WebSearch', `Read(/${imm}/**)`, `Edit(/${imm}/**)`, `Read(/${path.join(w.data, 'config', 'profile.yml')})`].sort(),
  );
  assert.equal(permissions.allow.some((rule) => /^(Read|Edit|Write|Bash)$/.test(rule) || rule.startsWith('Bash')), false);
  for (const p of HOME_READ_DENY) assert.ok(permissions.deny.includes(`Read(${p})`), `deny lacks Read(${p})`);
  for (const root of [w.root, w.data]) for (const g of READ_DENY) assert.ok(permissions.deny.includes(`Read(/${root}/${g})`), `deny lacks ${g} under ${root}`);
  assert.deepEqual(Object.keys(r.calls[0].settings), ['permissions']);
});

test('a data root inside the checkout adds no extra working directory', () => {
  const w = dailyWorld({ dataInside: true });
  const r = w.run();
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(r.calls[0].settings.permissions.additionalDirectories, []);
});

test('a data root that is the home directory is refused: claude never runs, the step fails and the other steps still run', () => {
  const w = dailyWorld({ homeIsData: true });
  const r = w.run();
  assert.equal(r.calls.length, 0, r.log);
  assert.match(r.log, /home directory/);
  assert.match(r.log, /!!! step failed: policy watch/);
  assert.match(r.steps, /^scan\.mjs/m);
  assert.match(r.steps, /^custom\/pipeline\/shortlist\.mjs/m);
  assert.doesNotMatch(r.steps, /^watch --ack/m, 'a refused pass acknowledges nothing');
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.leftovers, []);
});

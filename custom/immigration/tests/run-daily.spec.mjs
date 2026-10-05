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
const APPROVED = JSON.parse(readFileSync(path.join(ROOT, 'custom/control-center/server/core/contract.json'), 'utf8')).claude.approvedVersions;

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
  for (const rel of ['custom/immigration/run-daily.sh', 'custom/immigration/daily-prompt.md', 'path-resolver.mjs', 'lib/is-main-module.mjs']) put(rel, readFileSync(path.join(ROOT, rel), 'utf8'), 0o755);
  for (const rel of ['confinement.mjs', 'guard-hook.mjs', 'guard-policy.mjs', 'claude-shim.mjs']) put(`custom/control-center/server/claude/${rel}`, readFileSync(path.join(ROOT, 'custom/control-center/server/claude', rel), 'utf8'));
  put('custom/control-center/server/core/contract.json', JSON.stringify({ claude: { approvedVersions: APPROVED } }));
  put('custom/immigration/lib.mjs', readFileSync(path.join(ROOT, 'custom/immigration/lib.mjs'), 'utf8'));
  const stepLog = path.join(T, 'steps.log');
  const stub = (name) => `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(stepLog)}, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\n`;
  put('custom/immigration/watch.mjs', `${stub('watch')}if (!process.argv.includes('--ack')) process.stdout.write(JSON.stringify({ new_items: [] }));\n`);
  for (const rel of ['scan.mjs', 'custom/pipeline/prioritize.mjs', 'custom/pipeline/shortlist.mjs']) put(rel, stub(rel));
  // rank-pipeline.mjs stand-in: makes the call the real script makes with --cli claude, but never through an unwrapped
  // claude (the first one on PATH must be the shim's wrapper, or it records that and stops).
  put(
    'rank-pipeline.mjs',
    `${stub('rank-pipeline.mjs')}import path from 'node:path';\nimport { execFileSync } from 'node:child_process';\nconst first = process.env.PATH.split(':').map((d) => path.join(d, 'claude')).find((f) => fs.existsSync(f));\nconst small = first && fs.statSync(first).size < 65536;\nif (!small || !fs.readFileSync(first, 'utf8').includes('claude-shim.mjs')) { fs.appendFileSync(${JSON.stringify(stepLog)}, 'rank would run an unwrapped claude: ' + first + '\\n'); process.exit(1); }\nconst out = execFileSync('claude', ['-p', 'RANK PROMPT', '--model', 'sonnet'], { encoding: 'utf8' });\nfs.appendFileSync(${JSON.stringify(stepLog)}, 'rank got: ' + out.trim() + '\\n');\n`,
  );
  fs.writeFileSync(path.join(data, 'config/profile.yml'), 'location:\n  needs_sponsorship: true\n');
  fs.writeFileSync(path.join(bin, 'security'), '#!/bin/bash\necho fake-keychain-token\n', { mode: 0o755 });
  const record = path.join(T, 'claude-calls.ndjson');
  const fakeClaude = path.join(bin, 'fake-claude');
  fs.writeFileSync(fakeClaude, `#!${process.execPath}\n${readFileSync(path.join(HERE, 'fixtures', 'fake-claude.mjs'), 'utf8')}`, { mode: 0o755 });
  const run = (extraEnv = {}) => {
    // Never the real claude: the script must take CC_CLAUDE_BIN, or it would run the one on this machine.
    assert.match(readFileSync(path.join(root, 'custom/immigration/run-daily.sh'), 'utf8'), /\$\{CC_CLAUDE_BIN:-/, 'run-daily.sh must run claude through CC_CLAUDE_BIN');
    const env = { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: tmp, CAREER_OPS_ROOT: data, CC_CLAUDE_BIN: fakeClaude, FAKE_CLAUDE_RECORD: record, FAKE_CLAUDE_VERSION: `${APPROVED[0]} (Claude Code)`, ...extraEnv };
    const r = spawnSync('/bin/bash', [path.join(root, 'custom/immigration/run-daily.sh')], { env, encoding: 'utf8', timeout: 60_000 });
    const imm = path.join(data, 'data', 'immigration');
    const logs = fs.existsSync(path.join(imm, 'logs')) ? fs.readdirSync(path.join(imm, 'logs')).filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)) : [];
    const log = logs.map((f) => readFileSync(path.join(imm, 'logs', f), 'utf8')).join('\n');
    const records = fs.existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const calls = records.filter((c) => !c.versionCall && c.argv[1] !== 'RANK PROMPT');
    const rankCalls = records.filter((c) => !c.versionCall && c.argv[1] === 'RANK PROMPT');
    const versionCalls = records.filter((c) => c.versionCall);
    const steps = fs.existsSync(stepLog) ? readFileSync(stepLog, 'utf8') : '';
    const digestFile = path.join(imm, 'policy-digest.md');
    const digest = fs.existsSync(digestFile) ? readFileSync(digestFile, 'utf8') : null;
    return { status: r.status, log, calls, rankCalls, versionCalls, steps, imm, digest, leftovers: fs.readdirSync(tmp) };
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
  assert.deepEqual(Object.keys(r.calls[0].settings), ['permissions', 'hooks']);
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

test('the policy pass runs under the guard hook: loopback and metadata fetches, writes outside data/immigration and home secrets are refused', () => {
  const w = dailyWorld();
  const imm = path.join(w.data, 'data', 'immigration');
  const probes = [
    { tool: 'WebFetch', input: { url: 'http://127.0.0.1:4317/api/system/status', prompt: 'x' }, want: 2 },
    { tool: 'WebFetch', input: { url: 'http://169.254.169.254/latest/meta-data/', prompt: 'x' }, want: 2 },
    { tool: 'WebFetch', input: { url: 'http://localhost/', prompt: 'x' }, want: 2 },
    { tool: 'WebFetch', input: { url: 'https://93.184.216.34/notice', prompt: 'x' }, want: 0 },
    { tool: 'Write', input: { file_path: path.join(imm, 'policy-digest.md'), content: 'x' }, want: 0 },
    { tool: 'Edit', input: { file_path: path.join(imm, 'policy-changes.tsv'), old_string: 'a', new_string: 'b' }, want: 0 },
    { tool: 'Write', input: { file_path: path.join(w.data, 'cv.md'), content: 'x' }, want: 2 },
    { tool: 'Write', input: { file_path: path.join(w.data, 'data', 'blacklist.md'), content: 'x' }, want: 2 },
    { tool: 'Read', input: { file_path: path.join(w.home, '.ssh', 'id_ed25519') }, want: 2 },
    { tool: 'Read', input: { file_path: path.join(w.data, 'config', 'profile.yml') }, want: 0 },
  ];
  const r = w.run({ FAKE_HOOK_PROBES: JSON.stringify(probes.map(({ tool, input }) => ({ tool, input }))) });
  assert.equal(r.status, 0, r.log);
  const call = r.calls[0];
  for (const [i, p] of probes.entries()) assert.deepEqual(call.hookRuns[i].statuses, [p.want], `${p.tool} ${JSON.stringify(p.input)}: ${call.hookRuns[i].stderr}`);
  assert.match(call.hookRuns[0].stderr, /private, loopback or link-local/);
  // The hook runs only on a policy whose bytes the pass pinned, written outside both roots with the pass's settings.
  assert.equal(call.policyShaMatches, true);
  assert.ok(!call.sessionDir.startsWith(w.data) && !call.sessionDir.startsWith(w.root), call.sessionDir);
  assert.deepEqual(call.policy.allow, ['data/immigration/**']);
  assert.deepEqual(call.policy.bash, []);
  assert.equal(call.policy.codeRoot, w.root);
  assert.equal(call.policy.dataRoot, w.data);
  assert.ok(call.policy.deny.includes('data/blacklist.md'));
  const pre = call.settings.hooks.PreToolUse[0];
  for (const tool of ['WebFetch', 'Read', 'Write', 'Edit']) assert.ok(pre.matcher.split('|').includes(tool), `${tool} is not hooked`);
  assert.match(pre.hooks[0].command, /guard-hook\.mjs' \|\| exit 2$/);
  assert.equal(pre.hooks[0].timeout, 30);
  assert.ok(call.settings.hooks.PostToolUse[0].matcher.split('|').includes('Write'));
  assert.deepEqual(r.leftovers, []);
});

test('the pass runs only on an approved Claude Code, asked with the autoupdater off, and runs with the autoupdater off', () => {
  const w = dailyWorld();
  const r = w.run();
  assert.equal(r.status, 0, r.log);
  assert.equal(r.calls.length, 1, r.log);
  assert.ok(r.versionCalls.length >= 1, 'the version is checked before the pass');
  for (const v of r.versionCalls) assert.equal(v.disableAutoupdater, '1');
  assert.equal(r.calls[0].disableAutoupdater, '1');
});

test('an unapproved Claude Code skips the pass, not the job: a clear log line, a dated digest note, nothing acknowledged, the other steps run', () => {
  const w = dailyWorld();
  const today = new Date().toLocaleDateString('en-CA');
  const r = w.run({ FAKE_CLAUDE_VERSION: '2.1.290 (Claude Code)' });
  assert.equal(r.calls.length, 0, 'an unprobed CLI never runs the pass');
  assert.equal(r.status, 0, r.log);
  assert.match(r.log, /policy pass skipped: Claude Code 2\.1\.290 is not approved for the confined pass \(approved: /);
  assert.doesNotMatch(r.log, /!!! step failed: policy watch/);
  assert.match(r.digest, new RegExp(`^# Immigration policy digest\\n\\n## ${today}\\n- AI policy pass skipped: Claude Code 2\\.1\\.290 is not approved`));
  assert.doesNotMatch(r.steps, /^watch --ack/m, 'the official items stay pending for the next run');
  assert.match(r.steps, /^scan\.mjs/m);
  // The scheduled rank calls Claude too: it is skipped the same way, not failed.
  assert.equal(r.rankCalls.length, 0);
  assert.match(r.log, /rank skipped: Claude Code 2\.1\.290 is not approved/);
  assert.doesNotMatch(r.log, /!!! step failed: rank/);
  assert.doesNotMatch(r.steps, /^rank-pipeline\.mjs/m);
  assert.deepEqual(r.leftovers, []);
});

test('a Claude Code whose version cannot be read fails the step and never runs the pass', () => {
  const w = dailyWorld();
  const r = w.run({ FAKE_CLAUDE_VERSION: 'Claude Code is updating...' });
  assert.equal(r.calls.length, 0, r.log);
  assert.match(r.log, /could not read the Claude Code version/);
  assert.match(r.log, /!!! step failed: policy watch/);
  assert.equal(r.digest, null);
  assert.notEqual(r.status, 0);
});

test('the scheduled rank runs rank-pipeline.mjs with --cli claude behind the shim: its call reaches claude with no tools, no MCP servers and dontAsk', () => {
  const w = dailyWorld();
  const r = w.run({ CAREER_OPS_RANK_CLI: 'codex' });
  assert.equal(r.status, 0, `${r.log}\n${r.steps}`);
  assert.match(r.steps, /^rank-pipeline\.mjs --cli claude --limit 100 --model sonnet$/m, 'the CLI is pinned to claude, whatever CAREER_OPS_RANK_CLI says');
  assert.doesNotMatch(r.steps, /unwrapped claude/);
  assert.equal(r.rankCalls.length, 1, r.steps);
  assert.deepEqual(r.rankCalls[0].argv, ['-p', 'RANK PROMPT', '--model', 'sonnet', '--restricted', '--tools', '', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--disallowedTools', 'Bash,Edit,Write,MultiEdit,NotebookEdit,Read,Glob,Grep,WebFetch,WebSearch,Agent,Task,PowerShell']);
  assert.equal(r.rankCalls[0].disableAutoupdater, '1');
  assert.equal(r.rankCalls[0].token, true);
  assert.match(r.steps, /^rank got: SUMMARY/m);
  assert.deepEqual(r.leftovers, [], 'the shim folder lives only for the rank step');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
  const out = fillPrompt({ WATCH_JSON: watch, TODAY: '2026-10-04', IMM: imm, PROFILE: '/data/$&root/config/profile.yml' });
  assert.ok(out.includes(watch), out.slice(0, 2000));
  assert.ok(out.includes(`\`${imm}/policy-changes.tsv\``));
  assert.ok(out.includes('Today is 2026-10-04.'));
  assert.equal(out.includes('{{'), false, 'every placeholder is filled');
});

// ---- the policy pass runs confined, like a Control Center session ----

// run-daily.sh is a macOS launchd job that runs under /usr/bin/lockf. Where that is missing (a Linux --core-only
// install, whose self-test runs these specs), the tests that run the script are skipped rather than failed.
const jobTest = fs.existsSync('/usr/bin/lockf') ? test : (name, fn) => test(name, { skip: 'run-daily.sh is a macOS launchd job and needs /usr/bin/lockf' }, fn);

const CONFINEMENT = path.join(ROOT, 'custom/control-center/server/claude/confinement.mjs');
const APPROVED = JSON.parse(readFileSync(path.join(ROOT, 'custom/control-center/server/core/contract.json'), 'utf8')).claude.approvedVersions;

/**
 * A checkout with the real run-daily.sh, daily-prompt.md, path-resolver.mjs and confinement module and stubs for every
 * other step, a data root outside it, a fake Keychain and a fake claude that records its argv and the settings file it
 * was given. CC_CLAUDE_BIN points at the fake: the real claude on this machine is never run.
 */
function dailyWorld({ dataInside = false, homeIsData = false, approved = APPROVED } = {}) {
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
  for (const rel of ['custom/immigration/run-daily.sh', 'custom/immigration/daily-prompt.md', 'custom/launchd/pinned-node.sh', 'path-resolver.mjs', 'lib/is-main-module.mjs']) put(rel, readFileSync(path.join(ROOT, rel), 'utf8'), 0o755);
  for (const rel of ['confinement.mjs', 'guard-hook.mjs', 'guard-policy.mjs', 'claude-shim.mjs']) put(`custom/control-center/server/claude/${rel}`, readFileSync(path.join(ROOT, 'custom/control-center/server/claude', rel), 'utf8'));
  put('custom/control-center/server/core/contract.json', JSON.stringify({ claude: { approvedVersions: approved } }));
  for (const rel of ['lib.mjs', 'policy-claim.mjs']) put(`custom/immigration/${rel}`, readFileSync(path.join(ROOT, 'custom/immigration', rel), 'utf8'));
  const stepLog = path.join(T, 'steps.log');
  // Each step and the rank-pipeline stand-in also note whether the Claude OAuth token reached them.
  const tokenLog = path.join(T, 'step-tokens.log');
  const nodeLog = path.join(T, 'step-nodes.log');
  const stub = (name) => `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(stepLog)}, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\nfs.appendFileSync(${JSON.stringify(tokenLog)}, ${JSON.stringify(name)} + (process.env.CLAUDE_CODE_OAUTH_TOKEN ? ' token' : ' none') + '\\n');\nfs.appendFileSync(${JSON.stringify(nodeLog)}, process.execPath + '\\n');\n`;
  put('custom/immigration/watch.mjs', `${stub('watch')}if (!process.argv.includes('--ack')) process.stdout.write(JSON.stringify({ new_items: [] }));\n`);
  for (const rel of ['scan.mjs', 'custom/pipeline/prioritize.mjs', 'custom/pipeline/shortlist.mjs']) put(rel, stub(rel));
  // rank-pipeline.mjs stand-in: makes the call the real script makes with --cli claude, but never through an unwrapped
  // claude (the first one on PATH must be the shim's wrapper, or it records that and stops). Like the real script, it
  // catches a failed call, logs it, leaves the batch un-annotated and still exits 0. Its call times out like the real one
  // (120 s, which kills the claude it runs with SIGTERM); FAKE_RANK_TIMEOUT_MS shortens that for a test. With
  // FAKE_CLAUDE_PIDS set, that timeout starts only once the fake claude behind the shim has written its pids: under
  // load, starting the wrapper, the shim and the fake can alone take longer than a short timeout.
  put(
    'rank-pipeline.mjs',
    `${stub('rank-pipeline.mjs')}import path from 'node:path';\nimport { spawn } from 'node:child_process';\nconst first = process.env.PATH.split(':').map((d) => path.join(d, 'claude')).find((f) => fs.existsSync(f));\nconst small = first && fs.statSync(first).size < 65536;\nif (!small || !fs.readFileSync(first, 'utf8').includes('claude-shim.mjs')) { fs.appendFileSync(${JSON.stringify(stepLog)}, 'rank would run an unwrapped claude: ' + first + '\\n'); process.exit(1); }\nconst child = spawn('claude', ['-p', 'RANK PROMPT', '--model', 'sonnet'], { stdio: ['pipe', 'pipe', 'inherit'] });\nchild.stdin.end();\nlet out = '';\nchild.stdout.setEncoding('utf8').on('data', (d) => { out += d; });\nlet timer;\nconst arm = () => { timer = setTimeout(() => child.kill('SIGTERM'), Number(process.env.FAKE_RANK_TIMEOUT_MS || 120000)); };\nconst pids = process.env.FAKE_CLAUDE_PIDS;\nif (pids) { const poll = setInterval(() => { if (fs.existsSync(pids)) { clearInterval(poll); arm(); } }, 20); child.on('exit', () => clearInterval(poll)); } else arm();\nchild.on('close', (code, signal) => {\n  clearTimeout(timer);\n  if (code !== 0) {\n    console.error('  batch 1: CLI call failed (' + (signal ?? 'exit ' + code) + ') - entries left un-annotated');\n    fs.appendFileSync(${JSON.stringify(stepLog)}, 'rank batch failed\\n');\n    process.exit(0);\n  }\n  fs.appendFileSync(${JSON.stringify(stepLog)}, 'rank got: ' + out.trim() + '\\n');\n});\n`,
  );
  fs.writeFileSync(path.join(data, 'config/profile.yml'), 'location:\n  needs_sponsorship: true\n');
  fs.writeFileSync(path.join(bin, 'security'), '#!/bin/bash\necho fake-keychain-token\n', { mode: 0o755 });
  const record = path.join(T, 'claude-calls.ndjson');
  const fakeClaude = path.join(bin, 'fake-claude');
  fs.writeFileSync(fakeClaude, `#!${process.execPath}\n${readFileSync(path.join(HERE, 'fixtures', 'fake-claude.mjs'), 'utf8')}`, { mode: 0o755 });
  const envFor = (extraEnv) => {
    // Never the real claude: the script must take CC_CLAUDE_BIN, or it would run the one on this machine.
    assert.match(readFileSync(path.join(root, 'custom/immigration/run-daily.sh'), 'utf8'), /\$\{CC_CLAUDE_BIN:-/, 'run-daily.sh must run claude through CC_CLAUDE_BIN');
    // TZ passes through: the job dates its log and digest by its local day, which the specs compute in this process's zone.
    // CC_NODE_BIN: the node running these specs, pinned as the plist pins one; run-daily.sh puts Homebrew first on PATH.
    return { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, CC_NODE_BIN: process.execPath, HOME: home, TMPDIR: tmp, ...(process.env.TZ ? { TZ: process.env.TZ } : {}), CAREER_OPS_ROOT: data, CC_CLAUDE_BIN: fakeClaude, FAKE_CLAUDE_RECORD: record, FAKE_CLAUDE_VERSION: `${APPROVED[0]} (Claude Code)`, ...extraEnv };
  };
  // The job started in its own process group, as the Control Center runner starts it, for a spec that signals it mid-run.
  const start = (extraEnv = {}) => spawn('/bin/bash', [path.join(root, 'custom/immigration/run-daily.sh')], { env: envFor(extraEnv), stdio: 'ignore', detached: true });
  const run = (extraEnv = {}) => {
    const env = envFor(extraEnv);
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
    const stepTokens = fs.existsSync(tokenLog) ? readFileSync(tokenLog, 'utf8') : '';
    const stepNodes = fs.existsSync(nodeLog) ? [...new Set(readFileSync(nodeLog, 'utf8').trim().split('\n'))] : [];
    return { stepNodes, stepTokens, status: r.status, stderr: r.stderr, log, calls, rankCalls, versionCalls, steps, imm, digest, leftovers: fs.readdirSync(tmp) };
  };
  return { T, root, data, home, tmp, fakeClaude, run, start };
}

const flagValue = (argv, flag) => argv[argv.indexOf(flag) + 1];

jobTest('the policy pass runs claude --restricted with an exact tool list, no MCP servers and a settings file, never a bare Read or Bash', async () => {
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
  assert.equal(flagValue(argv, '--effort'), 'medium', '--restricted loads no user settings, so the effort must be explicit');
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

jobTest('the policy prompt names the profile by its absolute path in the data root, the one file the settings let it read (R8-14)', () => {
  const w = dailyWorld();
  const r = w.run();
  assert.equal(r.status, 0, r.log);
  const prompt = r.calls[0].argv[1];
  const profile = path.join(w.data, 'config', 'profile.yml');
  assert.ok(prompt.includes(`\`${profile}\``), prompt.slice(0, 400));
  // A relative config/profile.yml resolves against the pass's cwd, the checkout, which has no profile.
  assert.equal(/(^|[^/])config\/profile\.yml/.test(prompt.replaceAll(profile, '')), false, prompt.slice(0, 400));
  assert.ok(r.calls[0].settings.permissions.allow.includes(`Read(/${profile})`));
});

jobTest('the settings allow reads only of the immigration folder and the profile, writes only to the three files the pass produces, and deny the home credential stores and secret files', async () => {
  const { HOME_READ_DENY, READ_DENY } = await import(CONFINEMENT);
  const w = dailyWorld();
  const r = w.run();
  assert.equal(r.status, 0, r.log);
  const { permissions } = r.calls[0].settings;
  const imm = path.join(w.data, 'data', 'immigration');
  assert.deepEqual(permissions.additionalDirectories, [w.data]);
  assert.deepEqual(
    [...permissions.allow].sort(),
    ['WebFetch', 'WebSearch', `Read(/${imm}/**)`, `Edit(/${imm}/policy-changes.tsv)`, `Edit(/${imm}/company-alerts.tsv)`, `Edit(/${imm}/policy-digest.md)`, `Read(/${path.join(w.data, 'config', 'profile.yml')})`].sort(),
  );
  assert.equal(permissions.allow.some((rule) => /^(Read|Edit|Write|Bash)$/.test(rule) || rule.startsWith('Bash')), false);
  for (const p of HOME_READ_DENY) assert.ok(permissions.deny.includes(`Read(${p})`), `deny lacks Read(${p})`);
  for (const root of [w.root, w.data]) for (const g of READ_DENY) assert.ok(permissions.deny.includes(`Read(/${root}/${g})`), `deny lacks ${g} under ${root}`);
  assert.deepEqual(Object.keys(r.calls[0].settings), ['permissions', 'hooks']);
});

jobTest('a data root inside the checkout adds no extra working directory', () => {
  const w = dailyWorld({ dataInside: true });
  const r = w.run();
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(r.calls[0].settings.permissions.additionalDirectories, []);
});

jobTest('a data root that is the home directory is refused: claude never runs, the step fails and the other steps still run', () => {
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

jobTest('the policy pass runs under the guard hook: loopback and metadata fetches, writes outside data/immigration and home secrets are refused', () => {
  const w = dailyWorld();
  const imm = path.join(w.data, 'data', 'immigration');
  const probes = [
    { tool: 'WebFetch', input: { url: 'http://127.0.0.1:4317/api/system/status', prompt: 'x' }, want: 2 },
    { tool: 'WebFetch', input: { url: 'http://169.254.169.254/latest/meta-data/', prompt: 'x' }, want: 2 },
    { tool: 'WebFetch', input: { url: 'http://localhost/', prompt: 'x' }, want: 2 },
    { tool: 'WebFetch', input: { url: 'https://93.184.216.34/notice', prompt: 'x' }, want: 0 },
    { tool: 'Write', input: { file_path: path.join(imm, 'policy-digest.md'), content: 'x' }, want: 0 },
    { tool: 'Edit', input: { file_path: path.join(imm, 'policy-changes.tsv'), old_string: 'a', new_string: 'b' }, want: 0 },
    { tool: 'Edit', input: { file_path: path.join(imm, 'company-alerts.tsv'), old_string: 'a', new_string: 'b' }, want: 0 },
    // The job's own state and the cached sponsorship verdicts are not the pass's to write (SW7-scripts-02).
    { tool: 'Write', input: { file_path: path.join(imm, 'pending.json'), content: '[]' }, want: 2 },
    { tool: 'Write', input: { file_path: path.join(imm, 'seen.json'), content: '{}' }, want: 2 },
    { tool: 'Write', input: { file_path: path.join(imm, 'companies', 'acme.md'), content: 'verdict: sponsoring' }, want: 2 },
    { tool: 'Write', input: { file_path: path.join(imm, 'batches', 'run.json'), content: '{}' }, want: 2 },
    { tool: 'Write', input: { file_path: path.join(imm, '.run-daily.pid'), content: '1' }, want: 2 },
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
  assert.deepEqual(call.policy.allow, ['data/immigration/policy-changes.tsv', 'data/immigration/company-alerts.tsv', 'data/immigration/policy-digest.md']);
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

jobTest('the pass runs only on an approved Claude Code, asked with the autoupdater off, and runs with the autoupdater off', () => {
  const w = dailyWorld();
  const r = w.run();
  assert.equal(r.status, 0, r.log);
  assert.equal(r.calls.length, 1, r.log);
  assert.ok(r.versionCalls.length >= 1, 'the version is checked before the pass');
  for (const v of r.versionCalls) assert.equal(v.disableAutoupdater, '1');
  assert.equal(r.calls[0].disableAutoupdater, '1');
});

jobTest('an unapproved Claude Code skips the pass, not the job: a clear log line, a dated digest note, nothing acknowledged, the other steps run', () => {
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

jobTest('a Claude Code whose version cannot be read fails the step and never runs the pass', () => {
  const w = dailyWorld();
  const r = w.run({ FAKE_CLAUDE_VERSION: 'Claude Code is updating...' });
  assert.equal(r.calls.length, 0, r.log);
  assert.match(r.log, /could not read the Claude Code version/);
  assert.match(r.log, /!!! step failed: policy watch/);
  assert.equal(r.digest, null);
  assert.notEqual(r.status, 0);
});

jobTest('the scheduled rank runs rank-pipeline.mjs with --cli claude behind the shim: its call reaches claude with no tools, no MCP servers and dontAsk', () => {
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

jobTest('the Claude Code checked at the start is checked again right before each spawn: a binary updated meanwhile never runs the pass or the rank', () => {
  // Both versions are approved: what refuses the calls is the change itself, between the job's check and the spawn.
  const w = dailyWorld({ approved: ['2.1.289', '2.1.300'] });
  const r = w.run({ FAKE_CLAUDE_VERSIONS: JSON.stringify(['2.1.289 (Claude Code)', '2.1.300 (Claude Code)']) });
  assert.equal(r.calls.length, 0, r.log);
  assert.equal(r.rankCalls.length, 0, r.steps);
  assert.match(r.log, /Claude Code changed since the job checked it .*2\.1\.289.*2\.1\.300.*the pass is not run/);
  assert.match(r.log, /!!! step failed: policy watch/);
  assert.match(r.log, /!!! step failed: rank top 100/);
  assert.match(r.log, /Claude Code changed since the job checked it .*the rank is not run/);
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.leftovers, []);
});

jobTest('the log says which claude the job resolved, where from, and its real path and version', () => {
  const w = dailyWorld();
  const r = w.run();
  assert.equal(r.status, 0, r.log);
  assert.ok(r.log.includes(`claude: ${w.fakeClaude} (from CC_CLAUDE_BIN), ${fs.realpathSync(w.fakeClaude)}@${APPROVED[0]}`), r.log);
});

jobTest('a rank call the shim refuses fails the rank step, though rank-pipeline.mjs catches the failed call and exits 0', () => {
  // Both versions are approved and the job's own checks all see 2.1.289; only the shim, right before the call, sees 2.1.300.
  const w = dailyWorld({ approved: ['2.1.289', '2.1.300'] });
  const r = w.run({ FAKE_CLAUDE_VERSIONS: JSON.stringify(['2.1.289 (Claude Code)', '2.1.289 (Claude Code)', '2.1.289 (Claude Code)', '2.1.300 (Claude Code)']) });
  assert.equal(r.calls.length, 1, 'the policy pass still ran on the binary it checked');
  assert.equal(r.rankCalls.length, 0, r.steps);
  assert.match(r.steps, /^rank batch failed$/m, 'the stand-in caught the refused call, as the real script does');
  assert.match(r.log, /claude-shim: Claude Code changed since the job checked it .*2\.1\.289.*2\.1\.300.*the call is not run/);
  assert.match(r.log, /claude-shim refused 1 rank call\(s\); the rank step fails/);
  assert.match(r.log, /!!! step failed: rank top 100/);
  assert.doesNotMatch(r.log, /!!! step failed: policy watch/);
  assert.match(r.log, /done \(failed=1\)/);
  assert.notEqual(r.status, 0);
  assert.match(r.steps, /^custom\/pipeline\/shortlist\.mjs/m, 'the steps after the rank still run');
  assert.deepEqual(r.leftovers, []);
});

jobTest('a rank call the shim refuses for a flag it does not allow fails the rank step too', () => {
  const w = dailyWorld();
  // The stand-in's argv, as an upstream change to rank-pipeline.mjs could make it.
  const stand = path.join(w.root, 'rank-pipeline.mjs');
  fs.writeFileSync(stand, readFileSync(stand, 'utf8').replace("'--model', 'sonnet']", "'--model', 'sonnet', '--allowedTools', 'Bash']"));
  const r = w.run();
  assert.equal(r.rankCalls.length, 0, r.steps);
  assert.match(r.steps, /^rank batch failed$/m);
  assert.match(r.log, /claude-shim: --allowedTools is not allowed in a confined call/);
  assert.match(r.log, /!!! step failed: rank top 100/);
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.leftovers, []);
});

jobTest('a missing Keychain item ends the run with a !!! failure line the app reads as failed, before any step runs', () => {
  const w = dailyWorld();
  fs.writeFileSync(path.join(w.T, 'bin', 'security'), '#!/bin/bash\nexit 44\n', { mode: 0o755 });
  const r = w.run();
  assert.equal(r.status, 1, r.log);
  assert.match(r.log, /^!!! Keychain item 'career-ops-claude-token' not found\. Run: claude setup-token/m);
  assert.doesNotMatch(r.log, /^=== .* done/m);
  assert.equal(r.steps, '');
  assert.equal(r.calls.length, 0);
});

jobTest('the pidfile the Control Center reads names the run while it holds the lock and is gone when the run ends, done or failed', () => {
  const w = dailyWorld();
  // A step that sees the run from inside: the pidfile must name a live bash running run-daily.sh.
  const seen = path.join(w.T, 'pidfile-seen.txt');
  fs.writeFileSync(
    path.join(w.T, 'root', 'scan.mjs'),
    `import fs from 'node:fs';\nimport { execFileSync } from 'node:child_process';\nconst pid = fs.readFileSync(${JSON.stringify(path.join(w.T, 'data', 'data', 'immigration', '.run-daily.pid'))}, 'utf8').trim();\nfs.writeFileSync(${JSON.stringify(seen)}, execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' }));\n`,
  );
  const r = w.run();
  assert.equal(r.status, 0, r.log);
  assert.match(readFileSync(seen, 'utf8').trim(), /^\/bin\/bash .*\/custom\/immigration\/run-daily\.sh$/);
  assert.equal(fs.existsSync(path.join(r.imm, '.run-daily.pid')), false);
  fs.writeFileSync(path.join(w.T, 'bin', 'security'), '#!/bin/bash\nexit 44\n', { mode: 0o755 });
  assert.equal(w.run().status, 1);
  assert.equal(fs.existsSync(path.join(r.imm, '.run-daily.pid')), false);
});

jobTest('Given the plist pins a node (CC_NODE_BIN), every node the job runs is that one, though Homebrew comes first on its PATH', () => {
  const w = dailyWorld();
  const pinned = path.join(w.T, 'pinned');
  const calls = path.join(w.T, 'pinned-node.log');
  fs.mkdirSync(pinned);
  fs.writeFileSync(path.join(pinned, 'node'), `#!/bin/bash\necho "$*" >> "${calls}"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  const r = w.run({ CC_NODE_BIN: path.join(pinned, 'node') });
  assert.equal(r.status, 0, r.log);
  const seen = fs.existsSync(calls) ? readFileSync(calls, 'utf8') : '';
  assert.match(seen, /path-resolver\.mjs/, 'the data root was resolved with the pinned node');
  for (const step of ['scan.mjs', 'custom/pipeline/prioritize.mjs', 'rank-pipeline.mjs', 'custom/pipeline/shortlist.mjs']) assert.ok(seen.includes(step), `${step} ran on the pinned node:\n${seen}`);
});

jobTest('a failed policy pass acknowledges nothing: its batch stays pending for the next run, the step fails and the other steps still run', () => {
  const w = dailyWorld();
  const r = w.run({ FAKE_CLAUDE_EXIT: '1' });
  assert.equal(r.calls.length, 1, r.log);
  assert.doesNotMatch(r.steps, /^watch --ack/m);
  assert.match(r.log, /^!!! step failed: policy watch$/m);
  for (const step of ['scan.mjs', 'custom/pipeline/prioritize.mjs', 'custom/pipeline/shortlist.mjs']) assert.match(r.steps, new RegExp(`^${step} `, 'm'));
  assert.equal(r.status, 1);
  assert.deepEqual(r.leftovers, []);
});

jobTest('the policy pass is skipped with its reason while a Control Center session holds the policy-pass claim; the other steps still run (SW8-server-01 review)', () => {
  const w = dailyWorld();
  const sessionDir = path.join(w.data, 'data', 'control-center', 'sessions', 's-paused');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify({ id: 's-paused', mode: 'immigration-policy', status: 'awaiting_user' }));
  const claim = path.join(w.data, 'data', 'immigration', '.policy-pass.claim');
  fs.mkdirSync(path.dirname(claim), { recursive: true });
  fs.writeFileSync(claim, JSON.stringify({ owner: 'session:s-paused', batch: null, at: new Date().toISOString() }));
  const r = w.run();
  assert.equal(r.status, 0, r.log);
  assert.match(r.log, /policy pass skipped: another AI policy pass holds the queued items \(session:s-paused/);
  assert.deepEqual(r.calls, []);
  assert.match(r.steps, /scan\.mjs/);
  assert.equal(JSON.parse(readFileSync(claim, 'utf8')).owner, 'session:s-paused');
});

jobTest('a stale policy-pass claim (its session is gone) is taken over, the pass runs, and the claim is released after it', () => {
  const w = dailyWorld();
  const claim = path.join(w.data, 'data', 'immigration', '.policy-pass.claim');
  fs.mkdirSync(path.dirname(claim), { recursive: true });
  fs.writeFileSync(claim, JSON.stringify({ owner: 'session:s-deleted', batch: null, at: new Date().toISOString() }));
  const r = w.run();
  assert.equal(r.status, 0, r.log);
  assert.equal(r.calls.length, 1, r.log);
  assert.equal(fs.existsSync(claim), false);
});

jobTest('a run that starts while another holds the lock is skipped: a dated line in skipped.log, exit 0, no step runs', async () => {
  const w = dailyWorld();
  const imm = path.join(w.data, 'data', 'immigration');
  fs.mkdirSync(path.join(imm, 'logs'), { recursive: true });
  const lock = path.join(imm, '.run-daily.lockf');
  const holder = spawn('/usr/bin/lockf', ['-k', '-t', '0', lock, '/bin/sleep', '60'], { stdio: 'ignore' });
  try {
    // lockf creates the file with the lock already held (O_EXLOCK), so its existence means the lock is taken.
    for (let i = 0; i < 200 && !fs.existsSync(lock); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(fs.existsSync(lock), 'the holder never took the lock');
    const r = w.run();
    assert.equal(r.status, 0, r.log);
    assert.match(readFileSync(path.join(imm, 'logs', 'skipped.log'), 'utf8'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} another run-daily holds the lock; skipped$/m);
    assert.equal(r.steps, '');
    assert.equal(r.log, '', 'no dated run log is started');
  } finally {
    holder.kill();
  }
});

jobTest('a run the Control Center started (CC_RUN_DAILY_SKIP_EXIT) that finds the lock held says it was skipped and exits with that code (SW4-server-01)', async () => {
  const w = dailyWorld();
  const imm = path.join(w.data, 'data', 'immigration');
  fs.mkdirSync(path.join(imm, 'logs'), { recursive: true });
  const lock = path.join(imm, '.run-daily.lockf');
  const holder = spawn('/usr/bin/lockf', ['-k', '-t', '0', lock, '/bin/sleep', '60'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 200 && !fs.existsSync(lock); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(fs.existsSync(lock), 'the holder never took the lock');
    const r = w.run({ CC_RUN_DAILY_SKIP_EXIT: '75' });
    assert.equal(r.status, 75, r.stderr);
    assert.match(r.stderr, /^run-daily: skipped, because the daily job is already running \(another run holds its lock\)$/m);
    assert.match(readFileSync(path.join(imm, 'logs', 'skipped.log'), 'utf8'), /another run-daily holds the lock; skipped$/m);
    assert.equal(r.steps, '');
  } finally {
    holder.kill();
  }
});

jobTest('with no working node, the job stops with a clear reason instead of running against an empty data root (SW2-tests-12)', () => {
  const w = dailyWorld();
  // The pinned node goes first on the job's PATH (pinned-node.sh): one that answers nothing stands in for no node at all.
  const pinned = path.join(w.T, 'broken-node');
  fs.mkdirSync(pinned);
  fs.writeFileSync(path.join(pinned, 'node'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  const r = w.run({ CC_NODE_BIN: path.join(pinned, 'node') });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /run-daily: cannot resolve the career-ops data root/);
  assert.equal(r.steps, '');
  assert.equal(fs.existsSync(path.join(w.data, 'data', 'immigration')), false);
});

jobTest('a data root that does not exist (an unmounted drive, a moved folder) is refused, not created (SW2-tests-12)', () => {
  const w = dailyWorld();
  const missing = path.join(w.T, 'unmounted', 'career-data');
  const r = w.run({ CAREER_OPS_ROOT: missing });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /run-daily: cannot resolve the career-ops data root/);
  assert.equal(fs.existsSync(path.join(w.T, 'unmounted')), false);
  assert.equal(r.steps, '');
});

jobTest('rank calls that all fail (a usage limit, no network) fail the rank step, though rank-pipeline.mjs catches them and exits 0 (SW4-scripts-03)', () => {
  const w = dailyWorld();
  const r = w.run({ FAKE_CLAUDE_RANK_EXIT: '1' });
  assert.match(r.steps, /^rank batch failed$/m, 'the stand-in caught the failed call, as the real script does');
  assert.match(r.log, /^1 rank call\(s\) failed \(claude exited 1\); the rank step fails$/m);
  assert.match(r.log, /^!!! step failed: rank top 100$/m);
  assert.match(r.log, /^=== .* done \(failed=1\)$/m);
  assert.equal(r.status, 1);
  assert.match(r.steps, /^watch --ack /m, 'the policy pass before it still succeeded');
  assert.deepEqual(r.leftovers, []);
});

jobTest('a rank step whose calls succeed stays green', () => {
  const r = dailyWorld().run();
  assert.doesNotMatch(r.log, /rank call\(s\) failed|step failed: rank/);
  assert.equal(r.status, 0, r.log);
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

jobTest('a rank call killed by rank-pipeline\'s timeout fails the step and leaves no shim or claude running (SW4-scripts-03 review)', async () => {
  const w = dailyWorld();
  const pids = path.join(w.T, 'rank-claude.pids');
  const r = w.run({ FAKE_CLAUDE_RANK_SLEEP_MS: '30000', FAKE_CLAUDE_PIDS: pids, FAKE_RANK_TIMEOUT_MS: '1500' });
  assert.match(r.steps, /^rank batch failed$/m, 'the stand-in caught the timed-out call, as the real script does');
  assert.match(r.log, /^1 rank call\(s\) failed \(claude exited 143\); the rank step fails$/m);
  assert.match(r.log, /^!!! step failed: rank top 100$/m);
  assert.equal(r.status, 1);
  const [claudePid, shimPid] = readFileSync(pids, 'utf8').trim().split(' ').map(Number);
  for (let i = 0; i < 40 && (alive(claudePid) || alive(shimPid)); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(shimPid), false, 'the node shim was killed with the wrapper');
  assert.equal(alive(claudePid), false, 'the claude the shim ran was killed too');
  assert.equal(fs.existsSync(`${pids}.woke`), false, 'the claude was killed at the timeout, not left to run to its end');
});

for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) {
  jobTest(`a run cancelled with ${signal} during the rank step removes the shim folder that holds the OAuth token (R11-scripts-a-L1-01)`, async () => {
    const w = dailyWorld();
    const pids = path.join(w.T, 'rank-claude.pids');
    const child = w.start({ FAKE_CLAUDE_RANK_SLEEP_MS: '30000', FAKE_CLAUDE_PIDS: pids });
    const exited = new Promise((resolve) => child.on('exit', (status, sig) => resolve({ status, sig })));
    for (let i = 0; i < 600 && !fs.existsSync(pids); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(fs.existsSync(pids), 'the rank call never started');
    assert.equal(fs.readdirSync(w.tmp).filter((f) => f.startsWith('career-ops-rank-shim.')).length, 1, 'the token folder exists while the rank runs');
    // The lock holder, the bash that runs the steps and the cleanup; the started bash only waits on lockf.
    const imm = path.join(w.data, 'data', 'immigration');
    const holder = Number(readFileSync(path.join(imm, '.run-daily.pid'), 'utf8'));
    // The runner's cancel: the signal goes to the whole process group.
    process.kill(-child.pid, signal);
    const end = await exited;
    assert.notEqual(end.status, 0, `the cancelled run must not read as a success (${JSON.stringify(end)})`);
    for (let i = 0; i < 600 && alive(holder); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(alive(holder), false, 'the lock holder exits on the signal');
    assert.deepEqual(fs.readdirSync(w.tmp), [], `the token outlived the cancelled rank step (expected exit ${code})`);
    assert.equal(fs.existsSync(path.join(imm, '.run-daily.pid')), false, 'the pidfile goes too');
  });
}

test('the rank wrapper sets its TERM/INT trap before it starts the shim, so a timeout that comes first still records the failure and orphans nothing', () => {
  const body = readFileSync(RUN_DAILY, 'utf8');
  const wrapper = body.slice(body.indexOf('rank_top() {'));
  const trap = wrapper.indexOf('"trap on_term TERM INT"');
  const start = wrapper.indexOf('"$@" &`');
  assert.ok(trap > -1 && start > -1, 'the wrapper has a trap and a background start');
  assert.ok(trap < start, 'the trap comes before the shim starts');
  const handler = wrapper.slice(wrapper.indexOf('on_term() {'), wrapper.indexOf('}`', wrapper.indexOf('on_term() {')));
  // $! rather than a variable set after the start: a signal between the start and that assignment still finds the shim.
  assert.match(handler, /\[ -z "\$!" \] \|\| \{ kill -TERM -- "-\$!"/, 'the handler kills the shim group only once it exists');
  assert.match(handler, /echo 143 >> .*; exit 143;/, 'and always records the failure and exits 143');
});

jobTest('the Claude OAuth token reaches only the claude calls: no step (the scan and its provider plugins, prioritize, rank-pipeline, shortlist) sees it (SW7-scripts-01)', () => {
  const w = dailyWorld();
  const r = w.run({ CLAUDE_CODE_OAUTH_TOKEN: 'inherited-from-launchd' });
  assert.equal(r.status, 0, r.log);
  const seen = r.stepTokens.trim().split('\n');
  for (const step of ['watch', 'scan.mjs', 'custom/pipeline/prioritize.mjs', 'rank-pipeline.mjs', 'custom/pipeline/shortlist.mjs']) assert.ok(seen.includes(`${step} none`), `${step} saw the token:\n${r.stepTokens}`);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].token, true, 'the policy pass runs on the Keychain token');
  assert.equal(r.rankCalls.length, 1);
  assert.equal(r.rankCalls[0].token, true, 'the rank call reaches claude with the token, through the shim only');
});

test('the daily policy pass and the Control Center immigration-policy session may write exactly the same files (parity with modes.ts)', () => {
  const runDaily = readFileSync(RUN_DAILY, 'utf8');
  const outputs = JSON.parse(runDaily.match(/^const OUTPUTS = (\[[^\]]*\]);$/m)?.[1] ?? 'null');
  assert.ok(Array.isArray(outputs) && outputs.length === 3, 'run-daily.sh defines OUTPUTS once');
  const modes = readFileSync(path.join(ROOT, 'custom/control-center/server/claude/modes.ts'), 'utf8');
  const cls = modes.slice(modes.indexOf("'immigration-policy': {"));
  const globs = [...(cls.match(/writeGlobs: \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...globs].sort(), outputs.map((f) => `data/immigration/${f}`).sort());
});

jobTest('the job under test runs on the node running these specs, not a Homebrew one first on its PATH (SW4-tests-26)', () => {
  const r = dailyWorld().run();
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(r.stepNodes, [fs.realpathSync(process.execPath)]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs, { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';
import { CLI_CANDIDATES } from '../../../rank-pipeline.mjs';
import { spawnCpuLimited } from '../../test-support/cpu-limit.mjs';

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

// The argv the real rank-pipeline.mjs gives claude (its claude candidate, then --model as callCli adds it), so the
// stand-in below sends what the scheduled rank really sends.
const RANK_CLAUDE = CLI_CANDIDATES.find((c) => c.bin === 'claude');
const RANK_ARGV = [...RANK_CLAUDE.args('RANK PROMPT'), '--model', 'sonnet'];

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
  // ... and which Anthropic or Claude Code variables reached them, by name.
  const envLog = path.join(T, 'step-env.log');
  const stub = (name) => `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(stepLog)}, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\nfs.appendFileSync(${JSON.stringify(tokenLog)}, ${JSON.stringify(name)} + (process.env.CLAUDE_CODE_OAUTH_TOKEN ? ' token' : ' none') + '\\n');\nfs.appendFileSync(${JSON.stringify(nodeLog)}, process.execPath + '\\n');\nfs.appendFileSync(${JSON.stringify(envLog)}, ${JSON.stringify(name)} + ' ' + Object.keys(process.env).filter((k) => /^(ANTHROPIC_|CLAUDE_CODE_|CC_OAUTH_TOKEN$)/.test(k)).sort().join(',') + '\\n');\n`;
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
    `${stub('rank-pipeline.mjs')}import path from 'node:path';\nimport { spawn } from 'node:child_process';\nconst first = process.env.PATH.split(':').map((d) => path.join(d, 'claude')).find((f) => fs.existsSync(f));\nconst small = first && fs.statSync(first).size < 65536;\nif (!small || !fs.readFileSync(first, 'utf8').includes('claude-shim.mjs')) { fs.appendFileSync(${JSON.stringify(stepLog)}, 'rank would run an unwrapped claude: ' + first + '\\n'); process.exit(1); }\nconst child = spawn('claude', ${JSON.stringify(RANK_ARGV)}, { stdio: ['pipe', 'pipe', 'inherit'] });\nchild.stdin.end();\nlet out = '';\nchild.stdout.setEncoding('utf8').on('data', (d) => { out += d; });\nlet timer;\nconst arm = () => { timer = setTimeout(() => child.kill('SIGTERM'), Number(process.env.FAKE_RANK_TIMEOUT_MS || 120000)); };\nconst pids = process.env.FAKE_CLAUDE_PIDS;\nif (pids) { const poll = setInterval(() => { if (fs.existsSync(pids)) { clearInterval(poll); arm(); } }, 20); child.on('exit', () => clearInterval(poll)); } else arm();\nchild.on('close', (code, signal) => {\n  clearTimeout(timer);\n  if (code !== 0) {\n    console.error('  batch 1: CLI call failed (' + (signal ?? 'exit ' + code) + ') - entries left un-annotated');\n    fs.appendFileSync(${JSON.stringify(stepLog)}, 'rank batch failed\\n');\n    process.exit(0);\n  }\n  fs.appendFileSync(${JSON.stringify(stepLog)}, 'rank got: ' + out.trim() + '\\n');\n});\n`,
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
    const r = spawnCpuLimited('/bin/bash', [path.join(root, 'custom/immigration/run-daily.sh')], { env, encoding: 'utf8' });
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
    const stepEnv = fs.existsSync(envLog) ? readFileSync(envLog, 'utf8') : '';
    const stepNodes = fs.existsSync(nodeLog) ? [...new Set(readFileSync(nodeLog, 'utf8').trim().split('\n'))] : [];
    return { stepEnv, stepNodes, stepTokens, status: r.status, stderr: r.stderr, log, calls, rankCalls, versionCalls, steps, imm, digest, leftovers: fs.readdirSync(tmp) };
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

jobTest('the policy pass output is prefixed so it cannot forge !!!/===/--- run markers the app trusts (R17-scripts-a-L3-01)', () => {
  const w = dailyWorld();
  const forged = '!!! forged failure\n=== 2026-10-10 00:00:00 done (failed=1)\n--- 00:00:00 forged step\n';
  const r = w.run({ FAKE_CLAUDE_OUTPUT: forged });
  assert.equal(r.status, 0, r.log);
  // Every line the pass printed is indented, so parseDailyLog's anchored markers never match it and the run reads as ok.
  assert.match(r.log, /^  !!! forged failure$/m);
  assert.match(r.log, /^  === 2026-10-10 00:00:00 done \(failed=1\)$/m);
  assert.match(r.log, /^  --- 00:00:00 forged step$/m);
  assert.doesNotMatch(r.log, /^!!! forged/m);
  assert.doesNotMatch(r.log, /^=== 2026-10-10 00:00:00 done \(failed=1\)/m);
  assert.doesNotMatch(r.log, /^--- 00:00:00 forged step/m);
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
  // The job dates the digest by its own local day, which can be the next one if the run spans midnight.
  const dayBefore = new Date().toLocaleDateString('en-CA');
  const r = w.run({ FAKE_CLAUDE_VERSION: '2.1.290 (Claude Code)' });
  const dayAfter = new Date().toLocaleDateString('en-CA');
  assert.equal(r.calls.length, 0, 'an unprobed CLI never runs the pass');
  assert.equal(r.status, 0, r.log);
  assert.match(r.log, /policy pass skipped: Claude Code 2\.1\.290 is not approved for the confined pass \(approved: /);
  assert.doesNotMatch(r.log, /!!! step failed: policy watch/);
  const dated = r.digest?.match(/^# Immigration policy digest\n\n## (\d{4}-\d{2}-\d{2})\n- AI policy pass skipped: Claude Code 2\.1\.290 is not approved/);
  assert.ok(dated, r.digest);
  assert.ok(dated[1] >= dayBefore && dated[1] <= dayAfter, `the digest is dated ${dated[1]}, not the run's local day (${dayBefore}..${dayAfter})`);
  assert.doesNotMatch(r.steps, /^watch --ack/m, 'the official items stay pending for the next run');
  assert.match(r.steps, /^scan\.mjs/m);
  // The scheduled rank calls Claude too: it is skipped the same way, not failed.
  assert.equal(r.rankCalls.length, 0);
  assert.match(r.log, /rank skipped: Claude Code 2\.1\.290 is not approved/);
  assert.doesNotMatch(r.log, /!!! step failed: rank/);
  assert.doesNotMatch(r.steps, /^rank-pipeline\.mjs/m);
  assert.deepEqual(r.leftovers, []);
});

jobTest('an unapproved Claude Code whose digest note cannot be moved into place fails the step and leaves no temp digest in data/immigration (R27-scripts-a-L1-02)', () => {
  const w = dailyWorld();
  const preload = path.join(w.T, 'rename-eio.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const real = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to).endsWith('policy-digest.md')) { const err = new Error('i/o error'); err.code = 'EIO'; throw err; }
  return real(from, to);
};
syncBuiltinESMExports();
`);
  const r = w.run({ FAKE_CLAUDE_VERSION: '2.1.290 (Claude Code)', NODE_OPTIONS: `--import ${preload}` });
  assert.match(r.log, /policy pass skipped: Claude Code 2\.1\.290 is not approved/);
  assert.match(r.log, /EIO/, 'the failed rename reached the log');
  assert.match(r.log, /^!!! step failed: policy watch$/m, 'the failed note fails the step');
  assert.equal(r.digest, null, 'no digest was published');
  assert.deepEqual(fs.readdirSync(r.imm).filter((f) => f.includes('.tmp-')), [], 'the failed note left its temp digest behind');
});

jobTest('an unapproved Claude Code whose digest note cannot be moved into place logs the rename error, not a failed temp cleanup (R27-scripts-a-L1-02 review)', () => {
  const w = dailyWorld();
  const preload = path.join(w.T, 'rename-eio-rm-eacces.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realRename = fs.renameSync;
const realRm = fs.rmSync;
fs.renameSync = (from, to) => {
  if (String(to).endsWith('policy-digest.md')) { const err = new Error('i/o error'); err.code = 'EIO'; throw err; }
  return realRename(from, to);
};
fs.rmSync = (target, opts) => {
  if (String(target).includes('policy-digest.md.tmp-')) { const err = new Error('permission denied'); err.code = 'EACCES'; throw err; }
  return realRm(target, opts);
};
syncBuiltinESMExports();
`);
  const r = w.run({ FAKE_CLAUDE_VERSION: '2.1.290 (Claude Code)', NODE_OPTIONS: `--import ${preload}` });
  assert.match(r.log, /policy pass skipped: Claude Code 2\.1\.290 is not approved/);
  assert.match(r.log, /EIO/, 'the failed rename reached the log');
  assert.match(r.log, /^!!! step failed: policy watch$/m, 'the failed note fails the step');
  assert.match(r.log, /^Error: i\/o error$/m, 'the step failed on the rename error');
  assert.doesNotMatch(r.log, /^Error: permission denied$/m, 'the failed cleanup replaced the rename error');
  assert.match(r.log, /could not remove the temp digest .*policy-digest\.md\.tmp-\d+: permission denied/, 'the failed cleanup is noted');
  assert.equal(r.digest, null, 'no digest was published');
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

jobTest('the scheduled rank runs rank-pipeline.mjs with --cli claude behind the shim: its call reaches claude with no tools, no MCP servers, dontAsk and the session Read deny rules', async () => {
  const { buildReadDenyRules, HOME_READ_DENY, READ_DENY } = await import(CONFINEMENT);
  const w = dailyWorld();
  const r = w.run({ CAREER_OPS_RANK_CLI: 'codex' });
  assert.equal(r.status, 0, `${r.log}\n${r.steps}`);
  assert.match(r.steps, /^rank-pipeline\.mjs --cli claude --limit 100 --model sonnet$/m, 'the CLI is pinned to claude, whatever CAREER_OPS_RANK_CLI says');
  assert.doesNotMatch(r.steps, /unwrapped claude/);
  assert.equal(r.rankCalls.length, 1, r.steps);
  // The deny rules travel inline (no file to leave behind), the rule set a session gets under the checkout and the data root (R19-claude-L2-01).
  const settings = JSON.stringify({ permissions: { deny: buildReadDenyRules([w.root, w.data]) } });
  assert.deepEqual(r.rankCalls[0].argv, ['-p', 'RANK PROMPT', '--effort', 'medium', '--model', 'sonnet', '--settings', settings, '--restricted', '--tools', '', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--disallowedTools', 'Bash,Edit,Write,MultiEdit,NotebookEdit,Read,Glob,Grep,WebFetch,WebSearch,Agent,Task,PowerShell']);
  const { deny } = r.rankCalls[0].settings.permissions;
  for (const p of HOME_READ_DENY) assert.ok(deny.includes(`Read(${p})`), `deny lacks Read(${p})`);
  for (const root of [w.root, w.data]) for (const g of READ_DENY) assert.ok(deny.includes(`Read(/${root}/${g})`), `deny lacks ${g} under ${root}`);
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
  const source = readFileSync(stand, 'utf8');
  assert.ok(source.includes(JSON.stringify(RANK_ARGV)), 'the stand-in spawns claude with RANK_ARGV');
  fs.writeFileSync(stand, source.replace(JSON.stringify(RANK_ARGV), JSON.stringify([...RANK_ARGV, '--allowedTools', 'Bash'])));
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

jobTest('an empty Keychain item counts as missing: the run asks for a new token, before any step runs', () => {
  const w = dailyWorld();
  fs.writeFileSync(path.join(w.T, 'bin', 'security'), '#!/bin/bash\necho\n', { mode: 0o755 });
  const r = w.run();
  assert.equal(r.status, 1, r.log);
  assert.match(r.log, /^!!! Keychain item 'career-ops-claude-token' not found\. Run: claude setup-token/m);
  assert.equal(r.steps, '');
  assert.equal(r.calls.length, 0);
});

jobTest('a Keychain item holding only whitespace counts as missing, as the Control Center reads it', () => {
  const w = dailyWorld();
  fs.writeFileSync(path.join(w.T, 'bin', 'security'), '#!/bin/bash\nprintf "  \\r\\n"\n', { mode: 0o755 });
  const r = w.run();
  assert.equal(r.status, 1, r.log);
  assert.match(r.log, /^!!! Keychain item 'career-ops-claude-token' not found\. Run: claude setup-token/m);
  assert.equal(r.calls.length, 0);
});

jobTest('a Keychain token with surrounding whitespace reaches the policy pass trimmed', () => {
  const w = dailyWorld();
  fs.writeFileSync(path.join(w.T, 'bin', 'security'), '#!/bin/bash\nprintf " fake-keychain-token \\r\\n"\n', { mode: 0o755 });
  // The fake claude records only whether a token came: this wrapper records the value the policy pass was given.
  const seen = path.join(w.T, 'token-seen.txt');
  const wrapper = path.join(w.T, 'bin', 'token-claude');
  fs.writeFileSync(wrapper, `#!/bin/bash\n[ "$1" = "-p" ] && printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" > ${JSON.stringify(seen)}\nexec ${JSON.stringify(w.fakeClaude)} "$@"\n`, { mode: 0o755 });
  const r = w.run({ CC_CLAUDE_BIN: wrapper });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.calls.length, 1, r.log);
  assert.equal(readFileSync(seen, 'utf8'), 'fake-keychain-token');
});

jobTest('a temp folder the Keychain read cannot write to says so, never that the keychain is locked', () => {
  const w = dailyWorld();
  const r = w.run({ TMPDIR: path.join(w.T, 'no-such-tmp') });
  assert.equal(r.status, 1, r.log);
  assert.match(r.log, /^!!! Could not create a temp file for the Keychain read in .*no-such-tmp/m);
  assert.doesNotMatch(r.log, /unlock-keychain|setup-token/);
  assert.equal(r.steps, '');
});

jobTest('a Keychain that cannot be read (locked, exit 36) says so with the exit and stderr and asks for an unlock, never a new token', () => {
  const w = dailyWorld();
  fs.writeFileSync(path.join(w.T, 'bin', 'security'), '#!/bin/bash\necho "security: SecKeychainSearchCopyNext: User interaction is not allowed." >&2\nexit 36\n', { mode: 0o755 });
  const r = w.run();
  assert.equal(r.status, 1, r.log);
  assert.match(r.log, /^!!! Could not read Keychain item 'career-ops-claude-token': security failed \(exit 36: security: SecKeychainSearchCopyNext: User interaction is not allowed\.\)\..*Unlock it with: security unlock-keychain/m);
  assert.doesNotMatch(r.log, /setup-token/);
  assert.doesNotMatch(r.log, /^=== .* done/m);
  assert.equal(r.steps, '');
  assert.equal(r.calls.length, 0);
  assert.deepEqual(r.leftovers, []);
});

jobTest('a Keychain read that never answers (locked keychain, unlock prompt nobody answers) fails fast with the reason and frees the lock', () => {
  const w = dailyWorld();
  // A security that waits forever, as one blocked on an unanswered unlock dialog does (one process, as security is).
  // Every command line it has, the script's and the sleep's it becomes, names its own path: under load the alarm can
  // fire before the script has run a line, so the check below finds it by that path rather than by a pid it wrote.
  const security = path.join(w.T, 'bin', 'security');
  fs.writeFileSync(security, '#!/bin/bash\nexec -a "$0-waiting" /bin/sleep 100000\n', { mode: 0o755 });
  const started = Date.now();
  const r = w.run({ CC_KEYCHAIN_TIMEOUT: '2' });
  assert.ok(Date.now() - started < 30_000, `the run waited ${Date.now() - started} ms for the Keychain`);
  assert.equal(r.status, 1, r.log);
  assert.match(r.log, /^!!! Could not read Keychain item 'career-ops-claude-token': security did not answer within 2 s\. The login keychain is probably locked and waiting at an unlock prompt nobody answered\. Unlock it with: security unlock-keychain, then retry\.$/m);
  assert.doesNotMatch(r.log, /setup-token/);
  assert.equal(r.steps, '');
  assert.equal(r.calls.length, 0);
  assert.deepEqual(r.leftovers, []);
  assert.equal(fs.existsSync(path.join(r.imm, '.run-daily.pid')), false);
  const lock = spawnSync('/usr/bin/lockf', ['-k', '-t', '0', path.join(r.imm, '.run-daily.lockf'), '/usr/bin/true']);
  assert.equal(lock.status, 0, 'the daily lock is free once the run has failed');
  const orphan = spawnSync('/usr/bin/pgrep', ['-f', security.replace(/[^\w/-]/g, '\\$&')], { encoding: 'utf8' });
  assert.equal(orphan.stdout, '', 'nothing the Keychain read started is left running');
  assert.equal(orphan.status, 1, orphan.stderr);
});

// 4294967296 wraps to alarm(0) in perl, which would wait forever: the wait is capped at an hour.
for (const value of ['0', 'soon', '3601', '4294967296']) {
  jobTest(`a Keychain wait of '${value}' (not a whole number of seconds from 1 to 3600) is refused before the Keychain is read`, () => {
    const w = dailyWorld();
    const read = path.join(w.T, 'security-ran');
    fs.writeFileSync(path.join(w.T, 'bin', 'security'), `#!/bin/bash\ntouch ${JSON.stringify(read)}\necho fake-keychain-token\n`, { mode: 0o755 });
    const r = w.run({ CC_KEYCHAIN_TIMEOUT: value });
    assert.equal(r.status, 1, r.log);
    assert.match(r.log, new RegExp(`^!!! CC_KEYCHAIN_TIMEOUT must be a whole number of seconds from 1 to 3600, not '${value}'\\.$`, 'm'));
    assert.equal(fs.existsSync(read), false);
    assert.equal(r.steps, '');
  });
}

jobTest('a run cancelled while the Keychain read waits stops the security it started too and removes the read\'s stderr file', async () => {
  const w = dailyWorld();
  const securityPid = path.join(w.T, 'security.pid');
  fs.writeFileSync(path.join(w.T, 'bin', 'security'), `#!/bin/bash\necho $$ > ${JSON.stringify(securityPid)}\nexec /bin/sleep 100000\n`, { mode: 0o755 });
  const child = w.start();
  const exited = new Promise((resolve) => child.on('exit', (status, sig) => resolve({ status, sig })));
  for (let i = 0; i < 600 && !fs.existsSync(securityPid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(fs.existsSync(securityPid), 'the Keychain read never started');
  const pid = Number(readFileSync(securityPid, 'utf8'));
  const keychainErr = () => fs.readdirSync(w.tmp).filter((f) => f.startsWith('run-daily-keychain.'));
  assert.equal(keychainErr().length, 1, 'the Keychain read holds its stderr file while it waits');
  // The Control Center's cancel: SIGTERM to the job's process group.
  process.kill(-child.pid, 'SIGTERM');
  await exited;
  // The lock holder is a child of the bash that exited and finishes its EXIT trap on its own; the pid file goes last.
  const pidfile = path.join(w.data, 'data', 'immigration', '.run-daily.pid');
  for (let i = 0; i < 100 && fs.existsSync(pidfile); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(pidfile), false, 'the cancelled run never finished its EXIT trap');
  assert.deepEqual(keychainErr(), [], 'the cancelled run left the Keychain read\'s stderr file behind');
  for (let i = 0; i < 100 && alive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  const left = alive(pid);
  if (left) process.kill(pid, 'SIGKILL');
  assert.equal(left, false, 'the security the cancelled run started is still running');
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

/**
 * A watch.mjs stand-in whose --ack fails while a counter file says so (FAKE_ACK_FAILS: how many acks fail first), and
 * whose watch JSON is dated today (local), as the real one is.
 */
function failingAckWatch(w) {
  const steps = path.join(w.T, 'steps.log');
  const count = path.join(w.T, 'ack-count');
  fs.writeFileSync(
    path.join(w.root, 'custom/immigration/watch.mjs'),
    `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(steps)}, 'watch ' + process.argv.slice(2).join(' ') + '\\n');\nif (process.argv.includes('--ack')) {\n  const n = fs.existsSync(${JSON.stringify(count)}) ? Number(fs.readFileSync(${JSON.stringify(count)}, 'utf8')) : 0;\n  fs.writeFileSync(${JSON.stringify(count)}, String(n + 1));\n  if (n < Number(process.env.FAKE_ACK_FAILS || 0)) { console.error('pending.json.lock is busy'); process.exit(1); }\n  console.log('acknowledged 1 item(s); 0 still pending');\n} else {\n  const d = new Date();\n  const today = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');\n  process.stdout.write(JSON.stringify({ date: today, new_items: [{ id: 'x' }] }));\n}\n`,
  );
  return { reset: () => fs.rmSync(count, { force: true }) };
}

const ackedBatches = (steps) => [...steps.matchAll(/^watch --ack (\S+)$/gm)].map((m) => m[1]);
const doneMarks = (imm) => (fs.existsSync(path.join(imm, 'batches')) ? fs.readdirSync(path.join(imm, 'batches')).filter((f) => f.endsWith('.done')) : []);

jobTest('a failed ack after a successful pass is tried again in the same run, so a passing lock wait does not leave the items queued (R20-scripts-a-L1-01)', () => {
  const w = dailyWorld();
  failingAckWatch(w);
  // The retry waits before it tries again (the lock may still be busy): a sleep handed over as CC_SLEEP_BIN notes how long.
  const waits = path.join(w.T, 'waits');
  const recordingSleep = path.join(w.T, 'recording-sleep');
  fs.writeFileSync(recordingSleep, `#!/bin/bash\necho "$1" >> "${waits}"\nexec /bin/sleep "$@"\n`, { mode: 0o755 });
  const r = w.run({ FAKE_ACK_FAILS: '1', CC_SLEEP_BIN: recordingSleep });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.calls.length, 1, r.log);
  const acks = ackedBatches(r.steps);
  assert.equal(acks.length, 2, r.steps);
  assert.equal(acks[0], acks[1], 'the retry acknowledges the same batch');
  assert.equal(fs.existsSync(waits) ? readFileSync(waits, 'utf8') : '', '1\n', 'the retry waits a second before trying the ack again');
  assert.deepEqual(doneMarks(r.imm), [], 'an ack that landed leaves no .done marker');
});

jobTest('an ack that keeps failing leaves a .done marker, and the next run acknowledges that batch instead of sending its items to Claude again (R20-scripts-a-L1-01)', () => {
  const w = dailyWorld();
  const watch = failingAckWatch(w);
  const first = w.run({ FAKE_ACK_FAILS: '99' });
  assert.equal(first.calls.length, 1, first.log);
  assert.match(first.log, /^!!! step failed: policy watch$/m);
  const [batch] = ackedBatches(first.steps);
  assert.ok(batch, first.steps);
  assert.deepEqual(doneMarks(first.imm), [`${path.basename(batch)}.done`], 'the done pass is recorded beside its batch, for the Control Center or the next run to acknowledge');

  // The ack still failing on the next run: the leftover is not acknowledged, so the pass is not run again on its items.
  watch.reset();
  const second = w.run({ FAKE_ACK_FAILS: '99' });
  assert.equal(second.calls.length, 1, `Claude is not given the unacknowledged items again:\n${second.log}`);
  assert.match(second.log, /^!!! step failed: policy watch$/m);
  assert.deepEqual(doneMarks(second.imm), [`${path.basename(batch)}.done`]);

  // The lock free again: the leftover batch is acknowledged before anything else, then a new pass runs.
  watch.reset();
  fs.writeFileSync(path.join(w.T, 'steps.log'), '');
  const third = w.run();
  assert.equal(third.status, 0, third.log);
  const steps = third.steps.trim().split('\n').filter((l) => l.startsWith('watch'));
  assert.equal(steps[0], `watch --ack ${batch}`, third.steps);
  assert.equal(steps[1], 'watch ', third.steps);
  assert.equal(third.calls.length, 2, third.log);
  assert.equal(ackedBatches(third.steps).length, 2, third.steps);
  assert.deepEqual(doneMarks(third.imm), []);
});

jobTest('a leftover done batch from an old day is acknowledged before the new pass runs, whatever its age (r22 follow-up)', () => {
  const w = dailyWorld();
  failingAckWatch(w);
  const batches = path.join(w.data, 'data', 'immigration', 'batches');
  fs.mkdirSync(batches, { recursive: true });
  const old = path.join(batches, '20200101T000000-1.json');
  fs.writeFileSync(old, JSON.stringify({ date: '2020-01-01', new_items: [{ id: 'old' }] }));
  fs.writeFileSync(`${old}.done`, '2020-01-01T00:00:00Z\n');
  const r = w.run();
  assert.equal(r.status, 0, r.log);
  const steps = r.steps.trim().split('\n').filter((l) => l.startsWith('watch'));
  assert.equal(steps[0], `watch --ack ${old}`, r.steps);
  assert.deepEqual(doneMarks(r.imm), []);
  assert.equal(r.calls.length, 1, r.log);
});

for (const [what, text] of [
  ['is not JSON', '{not json'],
  ['holds an item watch.mjs --ack cannot read', JSON.stringify({ date: '2020-01-01', new_items: [null] })],
]) {
  jobTest(`a leftover done batch that ${what} is let go unacknowledged, and the pass runs (r22 follow-up)`, () => {
    const w = dailyWorld();
    failingAckWatch(w);
    const batches = path.join(w.data, 'data', 'immigration', 'batches');
    fs.mkdirSync(batches, { recursive: true });
    const garbled = path.join(batches, '20200101T000000-2.json');
    fs.writeFileSync(garbled, text);
    fs.writeFileSync(`${garbled}.done`, '2020-01-01T00:00:00Z\n');
    const r = w.run();
    assert.equal(r.status, 0, r.log);
    assert.equal(ackedBatches(r.steps).includes(garbled), false, r.steps);
    assert.match(r.log, /cannot be read/);
    assert.deepEqual(doneMarks(r.imm), []);
    assert.equal(r.calls.length, 1, r.log);
  });
}

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

/**
 * Holds run-daily's lock as another daily run does. Its own process group, so stop() kills lockf and its sleep together
 * (a signal to lockf alone leaves the sleep running for a minute). stop() returns whichever of them outlived it, for the
 * spec to assert after its finally, so a leak never hides the spec's own failure.
 */
async function lockHolder(imm) {
  const lock = path.join(imm, '.run-daily.lockf');
  const holder = spawn('/usr/bin/lockf', ['-k', '-t', '0', lock, '/bin/sleep', '60'], { stdio: 'ignore', detached: true });
  const kill = () => { try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* already gone */ } };
  const childrenOf = (pid) => spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number);
  let children = [];
  try {
    // lockf creates the file with the lock already held (O_EXLOCK), so its existence means the lock is taken.
    for (let i = 0; i < 200 && !fs.existsSync(lock); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(fs.existsSync(lock), 'the holder never took the lock');
    children = childrenOf(holder.pid);
    for (let i = 0; i < 200 && children.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      children = childrenOf(holder.pid);
    }
    assert.notDeepEqual(children, [], 'lockf never started its sleep');
  } catch (err) {
    kill();
    throw err;
  }
  return {
    stop: async () => {
      kill();
      const tree = [holder.pid, ...children];
      for (let i = 0; i < 200 && tree.some(alive); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
      return tree.filter(alive);
    },
  };
}

jobTest('a run that starts while another holds the lock is skipped: a dated line in skipped.log, exit 0, no step runs', async () => {
  const w = dailyWorld();
  const imm = path.join(w.data, 'data', 'immigration');
  fs.mkdirSync(path.join(imm, 'logs'), { recursive: true });
  const holder = await lockHolder(imm);
  let left;
  try {
    const r = w.run();
    assert.equal(r.status, 0, r.log);
    assert.match(readFileSync(path.join(imm, 'logs', 'skipped.log'), 'utf8'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} another run-daily holds the lock; skipped$/m);
    assert.equal(r.steps, '');
    assert.equal(r.log, '', 'no dated run log is started');
  } finally {
    left = await holder.stop();
  }
  assert.deepEqual(left, [], 'the lock holder leaves no process running');
});

jobTest('a run the Control Center started (CC_RUN_DAILY_SKIP_EXIT) that finds the lock held says it was skipped and exits with that code (SW4-server-01)', async () => {
  const w = dailyWorld();
  const imm = path.join(w.data, 'data', 'immigration');
  fs.mkdirSync(path.join(imm, 'logs'), { recursive: true });
  const holder = await lockHolder(imm);
  let left;
  try {
    const r = w.run({ CC_RUN_DAILY_SKIP_EXIT: '75' });
    assert.equal(r.status, 75, r.stderr);
    assert.match(r.stderr, /^run-daily: skipped, because the daily job is already running \(another run holds its lock\)$/m);
    assert.match(readFileSync(path.join(imm, 'logs', 'skipped.log'), 'utf8'), /another run-daily holds the lock; skipped$/m);
    assert.equal(r.steps, '');
  } finally {
    left = await holder.stop();
  }
  assert.deepEqual(left, [], 'the lock holder leaves no process running');
});

/** Holds run-daily's lock the way the weekly sync's live-checkout update does: it names its pid in .live-update.pid. */
async function liveUpdateHolder(imm, seconds) {
  fs.mkdirSync(path.join(imm, 'logs'), { recursive: true });
  const marker = path.join(imm, '.live-update.pid');
  const holder = spawn('/usr/bin/lockf', ['-k', '-t', '0', path.join(imm, '.run-daily.lockf'), '/bin/sh', '-c', `echo $$ > "$1"; sleep ${seconds}; rm -f "$1"`, 'holder', marker], { stdio: 'ignore', detached: true });
  for (let i = 0; i < 200 && !fs.existsSync(marker); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(fs.existsSync(marker), 'the live update never took the lock');
  return { marker, stop: () => { try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* already gone */ } } };
}

jobTest('a scheduled run that finds the weekly sync updating the live checkout waits for the update, then runs (R15-scripts-b-L1-02)', async () => {
  const w = dailyWorld();
  const imm = path.join(w.data, 'data', 'immigration');
  const update = await liveUpdateHolder(imm, 1.5);
  try {
    const r = w.run();
    assert.equal(r.status, 0, r.log + r.stderr);
    assert.match(r.steps, /scan\.mjs/);
    assert.equal(fs.existsSync(path.join(imm, 'logs', 'skipped.log')), false);
  } finally {
    update.stop();
  }
});

jobTest('a scheduled run that finds the update holding the lock an instant before it names its pid waits instead of skipping the day (R15-scripts-b-L1-02 review)', async () => {
  const w = dailyWorld();
  const imm = path.join(w.data, 'data', 'immigration');
  fs.mkdirSync(path.join(imm, 'logs'), { recursive: true });
  const marker = path.join(imm, '.live-update.pid');
  const holderPid = path.join(w.T, 'holder.pid');
  const polls = path.join(w.T, 'polls');
  // The update names its pid during the last sleep of the polling window: the run must still see it (a check after
  // the last sleep). A sleep handed to the run as CC_SLEEP_BIN counts the window's 0.05 s polls and writes the marker as
  // the last one starts, so the timing is exact rather than a guess at when the window opens. The holder keeps the lock
  // until a second after the marker appears, however late the run reaches its last poll.
  const countingSleep = path.join(w.T, 'counting-sleep');
  // A plain sleep in a folder run-daily.sh puts ahead of the caller's PATH, as a host with a sleep in /opt/homebrew/bin
  // or /usr/local/bin has one: the run must still poll through the sleep it was handed, not whichever PATH finds first.
  fs.mkdirSync(path.join(w.home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(w.home, '.local', 'bin', 'sleep'), '#!/bin/bash\nexec /bin/sleep "$@"\n', { mode: 0o755 });
  fs.writeFileSync(countingSleep, `#!/bin/bash
if [ "$1" = 0.05 ]; then
  n=$(( $(cat "${polls}" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${polls}"
  [ "$n" = 24 ] && cp "${holderPid}" "${marker}.tmp" && mv "${marker}.tmp" "${marker}"
fi
exec /bin/sleep "$@"
`, { mode: 0o755 });
  const holder = spawn('/usr/bin/lockf', ['-k', '-t', '0', path.join(imm, '.run-daily.lockf'), '/bin/sh', '-c', `echo $$ > "$1"; for _ in $(seq 600); do [ -e "$2" ] && break; /bin/sleep 0.05; done; /bin/sleep 1; rm -f "$2"`, 'holder', holderPid, marker], { stdio: 'ignore', detached: true });
  try {
    for (let i = 0; i < 200 && !fs.existsSync(holderPid); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(fs.existsSync(holderPid), 'the update never took the lock');
    const r = w.run({ CC_SLEEP_BIN: countingSleep });
    assert.equal(fs.existsSync(polls) ? readFileSync(polls, 'utf8') : '', '24\n', 'the run did not poll the whole window through CC_SLEEP_BIN');
    assert.equal(r.status, 0, r.log + r.stderr);
    assert.match(r.steps, /scan\.mjs/);
    assert.equal(fs.existsSync(path.join(imm, 'logs', 'skipped.log')), false);
  } finally {
    try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

jobTest('a scheduled run that finds the lock held by an update that ends before the run reads its marker runs instead of skipping the day (R33-flake-rundaily)', async () => {
  const w = dailyWorld();
  const imm = path.join(w.data, 'data', 'immigration');
  fs.mkdirSync(path.join(imm, 'logs'), { recursive: true });
  const marker = path.join(imm, '.live-update.pid');
  const release = path.join(w.T, 'release');
  // The update holds the lock with its marker in place until told to finish, then removes the marker and exits, as the
  // weekly sync does. The run's first poll sleep tells it to finish and waits until it has let go of the lock, so the
  // run's lock attempt failed while the update ran but every marker read comes after the update ended.
  const holder = spawn('/usr/bin/lockf', ['-k', '-t', '0', path.join(imm, '.run-daily.lockf'), '/bin/sh', '-c', `echo $$ > "$1"; for _ in $(seq 1200); do [ -e "$2" ] && break; /bin/sleep 0.05; done; rm -f "$1"`, 'holder', marker, release], { stdio: 'ignore', detached: true });
  const finished = new Promise((resolve) => holder.on('exit', resolve));
  const countingSleep = path.join(w.T, 'release-sleep');
  fs.writeFileSync(countingSleep, `#!/bin/bash
if [ "$1" = 0.05 ] && [ ! -e "${release}" ]; then
  touch "${release}"
  for _ in $(seq 1200); do /usr/bin/lockf -k -t 0 "${path.join(imm, '.run-daily.lockf')}" /usr/bin/true 2>/dev/null && break; /bin/sleep 0.05; done
fi
exec /bin/sleep "$@"
`, { mode: 0o755 });
  try {
    for (let i = 0; i < 200 && !fs.existsSync(marker); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(fs.existsSync(marker), 'the update never took the lock');
    const r = w.run({ CC_SLEEP_BIN: countingSleep });
    assert.ok(fs.existsSync(release), 'the run never polled for the update marker');
    assert.equal(r.status, 0, r.log + r.stderr);
    assert.match(r.steps, /scan\.mjs/);
    assert.equal(fs.existsSync(path.join(imm, 'logs', 'skipped.log')), false);
  } finally {
    try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* already gone */ }
    await finished;
  }
});

// The installer borrows the same lock and marker as the weekly sync, so the message names neither alone (R18 review).
jobTest('a run the Control Center started while an install or the weekly sync updates the live checkout says so instead of claiming the daily job runs (R15-scripts-b-L1-02)', async () => {
  const w = dailyWorld();
  const imm = path.join(w.data, 'data', 'immigration');
  const update = await liveUpdateHolder(imm, 60);
  try {
    const r = w.run({ CC_RUN_DAILY_SKIP_EXIT: '75' });
    assert.equal(r.status, 75, r.stderr);
    assert.match(r.stderr, /^run-daily: skipped, because an install or update is changing the live checkout \(it holds the daily job's lock\); try again in a few minutes$/m);
    assert.equal(r.steps, '');
  } finally {
    update.stop();
  }
});

jobTest('a .live-update.pid left by an update that is gone does not make a run wait on another daily run', async () => {
  const w = dailyWorld();
  const imm = path.join(w.data, 'data', 'immigration');
  fs.mkdirSync(path.join(imm, 'logs'), { recursive: true });
  // A pid no process has: the update that wrote it was killed before it could remove it.
  fs.writeFileSync(path.join(imm, '.live-update.pid'), '999999\n');
  const holder = await lockHolder(imm);
  let left;
  try {
    const started = Date.now();
    const r = w.run();
    assert.equal(r.status, 0, r.log);
    assert.ok(Date.now() - started < 20_000, 'the run waited on the lock');
    assert.match(readFileSync(path.join(imm, 'logs', 'skipped.log'), 'utf8'), /another run-daily holds the lock; skipped$/m);
    assert.equal(r.steps, '');
  } finally {
    left = await holder.stop();
  }
  assert.deepEqual(left, [], 'the lock holder leaves no process running');
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
    // The shim runs in its own process group (set -m), so the group signal reaches it only through the wrapper's trap.
    const [claudePid, shimPid] = readFileSync(pids, 'utf8').trim().split(' ').map(Number);
    for (let i = 0; i < 40 && (alive(claudePid) || alive(shimPid)); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(alive(shimPid), false, `the node shim outlived the ${signal} cancel (R30-scripts-a-L1-01)`);
    assert.equal(alive(claudePid), false, `the claude the shim ran outlived the ${signal} cancel, holding the token (R30-scripts-a-L1-01)`);
  });
}

test('the rank wrapper sets its TERM/INT/HUP/QUIT trap before it starts the shim, so a timeout that comes first still records the failure and orphans nothing', () => {
  const body = readFileSync(RUN_DAILY, 'utf8');
  const wrapper = body.slice(body.indexOf('rank_top() {'));
  const trap = wrapper.indexOf('"trap on_term TERM INT HUP QUIT"');
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

jobTest('the policy pass and the rank call run claude with SUBPROCESS_ENV_SCRUB on, so its hook children never see the OAuth token (R29-tests-custom-L1-01)', () => {
  const w = dailyWorld();
  const r = w.run();
  assert.equal(r.status, 0, r.log);
  assert.equal(r.calls.length, 1, r.log);
  assert.equal(r.calls[0].token, true, 'the policy pass runs on the Keychain token');
  assert.equal(r.calls[0].scrub, true, 'the policy pass sets CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1');
  assert.equal(r.calls[0].hookChildToken, false, 'a hook child of the policy pass saw the OAuth token');
  assert.equal(r.rankCalls.length, 1, r.steps);
  assert.equal(r.rankCalls[0].token, true, 'the rank call runs on the Keychain token');
  assert.equal(r.rankCalls[0].scrub, true, 'the rank call sets CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1');
  assert.equal(r.rankCalls[0].hookChildToken, false, 'a hook child of the rank call saw the OAuth token');
});

jobTest('no step sees an inherited ANTHROPIC_* variable or a credential CLAUDE_CODE_* one, and the claude calls still get the Keychain token', () => {
  const w = dailyWorld();
  const scrubbed = { ANTHROPIC_API_KEY: 'sk-ant-x', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://proxy.example', ANTHROPIC_CUSTOM_HEADERS: 'X-Key: k', CLAUDE_CODE_API_KEY_HELPER: '/bin/k', CLAUDE_CODE_CLIENT_CERT: '/c.pem', CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: 'p', CLAUDE_CODE_SECRET: 's', CLAUDE_CODE_PASSWORD: 'p', CLAUDE_CODE_CREDENTIALS: 'c', CLAUDE_CODE_CREDENTIAL_FILE: 'f', CLAUDE_CODE_EXTRA_HEADER: 'h' };
  const r = w.run({ ...scrubbed, CLAUDE_CODE_USE_BEDROCK: '0' });
  assert.equal(r.status, 0, r.log);
  const lines = r.stepEnv.trim().split('\n');
  for (const step of ['watch', 'scan.mjs', 'custom/pipeline/prioritize.mjs', 'rank-pipeline.mjs', 'custom/pipeline/shortlist.mjs']) {
    const line = lines.find((l) => l.startsWith(`${step} `));
    assert.ok(line, `${step} did not run:\n${r.stepEnv}`);
    assert.deepEqual(line.slice(step.length + 1).split(',').filter(Boolean), ['CLAUDE_CODE_USE_BEDROCK'], `${step} saw a credential variable: ${line}`);
  }
  assert.equal(r.calls[0].token, true, 'the policy pass runs on the Keychain token');
  assert.equal(r.rankCalls[0].token, true, 'the rank call gets the token through the shim');
});

jobTest('an exported CC_OAUTH_TOKEN in the job environment reaches no step: the Keychain token reassigned to it stays in the script (R27-scripts-a-H-01)', () => {
  const w = dailyWorld();
  const r = w.run({ CC_OAUTH_TOKEN: 'inherited-from-launchd' });
  assert.equal(r.status, 0, r.log);
  const lines = r.stepEnv.split('\n');
  for (const step of ['watch', 'scan.mjs', 'custom/pipeline/prioritize.mjs', 'rank-pipeline.mjs', 'custom/pipeline/shortlist.mjs']) {
    const line = lines.find((l) => l.startsWith(`${step} `));
    assert.ok(line, `${step} did not run:\n${r.stepEnv}`);
    assert.ok(!line.split(/[ ,]/).includes('CC_OAUTH_TOKEN'), `${step} saw CC_OAUTH_TOKEN: ${line}`);
  }
  assert.equal(r.calls[0].token, true, 'the policy pass runs on the Keychain token');
  assert.equal(r.rankCalls[0].token, true, 'the rank call gets the token through the shim');
});

jobTest('an exported CC_OAUTH_TOKEN never reaches the data-root resolver that runs before the lock re-exec (R27-scripts-a-H-01 review)', () => {
  const w = dailyWorld();
  const seen = path.join(w.T, 'resolver-env.log');
  const resolver = path.join(w.root, 'path-resolver.mjs');
  fs.appendFileSync(resolver, `\nimport { appendFileSync as __log } from 'node:fs';\n__log(${JSON.stringify(seen)}, (process.env.CC_OAUTH_TOKEN ? 'token' : 'none') + '\\n');\n`);
  const r = w.run({ CC_OAUTH_TOKEN: 'inherited-from-launchd' });
  assert.equal(r.status, 0, r.log);
  const lines = readFileSync(seen, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 1 && lines[0] !== '', 'the resolver ran');
  assert.deepEqual([...new Set(lines)], ['none'], `the resolver saw CC_OAUTH_TOKEN: ${lines}`);
});

jobTest('an inherited ANTHROPIC_* or credential CLAUDE_CODE_* variable never reaches the data-root resolver that runs before the lock re-exec (R27-scripts-a-H-01 review)', () => {
  const w = dailyWorld();
  const seen = path.join(w.T, 'resolver-env.log');
  const resolver = path.join(w.root, 'path-resolver.mjs');
  fs.appendFileSync(resolver, `\nimport { appendFileSync as __log } from 'node:fs';\nif (process.argv.length === 1) __log(${JSON.stringify(seen)}, Object.keys(process.env).filter((k) => /^(ANTHROPIC_|CLAUDE_CODE_)/.test(k)).sort().join(',') + '\\n');\n`);
  const r = w.run({ ANTHROPIC_API_KEY: 'inherited-key', CLAUDE_CODE_OAUTH_TOKEN: 'inherited-token', CLAUDE_CODE_ENTRYPOINT: 'cli' });
  assert.equal(r.status, 0, r.log);
  // Only the script's own resolver call (node -e, once before the lock re-exec and once after it) is logged: the claude
  // shim imports the resolver too, and it is meant to hold the Keychain token.
  const lines = readFileSync(seen, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, `the resolver ran before and after the re-exec: ${lines}`);
  assert.deepEqual([...new Set(lines)], ['CLAUDE_CODE_ENTRYPOINT'], `the resolver saw an Anthropic credential: ${lines}`);
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

const batchFiles = (imm) => (fs.existsSync(path.join(imm, 'batches')) ? fs.readdirSync(path.join(imm, 'batches')).sort() : []);

for (const [what, env] of [
  ['the claude call fails (a usage limit, no network)', { FAKE_CLAUDE_EXIT: '1' }],
  ['the version re-check before the spawn refuses the pass', { FAKE_CLAUDE_VERSIONS: JSON.stringify(['2.1.289 (Claude Code)', '2.1.300 (Claude Code)']) }],
]) {
  jobTest(`a policy pass that ends not done because ${what} leaves no batch behind (R22-scripts-a-L1-01)`, () => {
    const w = dailyWorld({ approved: ['2.1.289', '2.1.300', ...APPROVED] });
    failingAckWatch(w);
    const r = w.run(env);
    assert.match(r.log, /^!!! step failed: policy watch$/m);
    assert.equal(ackedBatches(r.steps).length, 0, r.steps);
    assert.deepEqual(batchFiles(r.imm), [], 'nothing reads a batch that was never recorded done');
  });
}

jobTest('a policy pass cancelled while claude runs leaves no batch behind (R22-scripts-a-L1-01)', async () => {
  const w = dailyWorld();
  failingAckWatch(w);
  // The policy call, not the rank: it notes it started, then waits to be cancelled.
  const started = path.join(w.T, 'policy-started');
  fs.writeFileSync(w.fakeClaude, `#!/bin/bash\nif [ "$1" = --version ]; then echo "${APPROVED[0]} (Claude Code)"; exit 0; fi\ntouch "${started}"\nexec /bin/sleep 30\n`, { mode: 0o755 });
  const child = w.start();
  const exited = new Promise((resolve) => child.on('exit', (status, sig) => resolve({ status, sig })));
  for (let i = 0; i < 600 && !fs.existsSync(started); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(fs.existsSync(started), 'the policy call never started');
  const imm = path.join(w.data, 'data', 'immigration');
  assert.equal(batchFiles(imm).filter((f) => f.endsWith('.json')).length, 1, 'the batch exists while the pass runs');
  const holder = Number(readFileSync(path.join(imm, '.run-daily.pid'), 'utf8'));
  process.kill(-child.pid, 'SIGTERM');
  await exited;
  for (let i = 0; i < 600 && alive(holder); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(holder), false, 'the lock holder exits on the signal');
  assert.deepEqual(batchFiles(imm), [], 'a cancelled pass leaves no batch behind');
});

jobTest('a cancelled run keeps a batch already recorded done, for the next run to acknowledge (R22-scripts-a-L1-01)', async () => {
  const w = dailyWorld();
  failingAckWatch(w);
  // The ack hangs, so the cancel lands after the pass is recorded done.
  const acking = path.join(w.T, 'acking');
  fs.writeFileSync(
    path.join(w.root, 'custom/immigration/watch.mjs'),
    `import fs from 'node:fs';\nif (process.argv.includes('--ack')) { fs.writeFileSync(${JSON.stringify(acking)}, ''); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); process.exit(1); }\nprocess.stdout.write(JSON.stringify({ new_items: [{ id: 'x' }] }));\n`,
  );
  const child = w.start();
  const exited = new Promise((resolve) => child.on('exit', (status, sig) => resolve({ status, sig })));
  for (let i = 0; i < 600 && !fs.existsSync(acking); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(fs.existsSync(acking), 'the ack never started');
  const imm = path.join(w.data, 'data', 'immigration');
  const holder = Number(readFileSync(path.join(imm, '.run-daily.pid'), 'utf8'));
  process.kill(-child.pid, 'SIGTERM');
  await exited;
  for (let i = 0; i < 600 && alive(holder); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  const left = batchFiles(imm);
  assert.equal(left.length, 2, left.join(' '));
  assert.ok(left[1] === `${left[0]}.done`, left.join(' '));
});

jobTest('a leftover done batch that cannot be read is removed with its .done marker (R22-scripts-a-L1-01)', () => {
  const w = dailyWorld();
  failingAckWatch(w);
  const batches = path.join(w.data, 'data', 'immigration', 'batches');
  fs.mkdirSync(batches, { recursive: true });
  const garbled = path.join(batches, '20200101T000000-3.json');
  fs.writeFileSync(garbled, '{not json');
  fs.writeFileSync(`${garbled}.done`, '2020-01-01T00:00:00Z\n');
  const r = w.run();
  assert.equal(r.status, 0, r.log);
  assert.equal(fs.existsSync(garbled), false, 'the unreadable batch goes with its marker');
  assert.deepEqual(doneMarks(r.imm), []);
  assert.deepEqual(batchFiles(r.imm), ackedBatches(r.steps).map((b) => path.basename(b)), 'only the batch of the pass just acknowledged stays, as the Control Center keeps one');
});

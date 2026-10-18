// install.sh specs: onboarding. Split from install.spec.mjs so the files run in parallel (shared setup in install-fixtures.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installLogs } from './harness.mjs';
import { SECRET, QUIET, fresh, READY_FILES, read, exists, md } from './install-fixtures.mjs';

// ---------------------------------------------------------------- onboarding

test('by default without a TTY onboarding is not started: the interactive command is printed with the copied paths and claude is not called', () => {
  const { w, D } = fresh({ keychain: true });
  const resume = md(w, 'resume.md', '# Me\n');
  const doc = md(w, 'proj.md', '# P\n');
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--resume', resume, '--docs', doc]);
  assert.equal(w.calls('claude').length, 0);
  assert.match(r.out, /claude '?"?Read custom\/install\/ONBOARDING\.md and follow it\./);
  assert.ok(r.out.includes(path.join(D, 'documents', 'cv', 'resume.md')));
  assert.ok(r.out.includes(path.join(D, 'documents', 'projects', 'proj.md')));
});

test('--onboard none prints the command even on a terminal', () => {
  const { w, D } = fresh({ keychain: true });
  const r = w.run(['--dir', D, ...QUIET], { tty: 'y\n' });
  assert.equal(w.calls('claude').length, 0);
  assert.match(r.out, /Read custom\/install\/ONBOARDING\.md and follow it/);
});

test('--onboard interactive starts claude without -p, from the checkout, with a prompt naming ONBOARDING.md and the paths', () => {
  const { w, D } = fresh({ keychain: true });
  const resume = md(w, 'resume.md', '# Me\n');
  const doc = md(w, 'proj.md', '# P\n');
  w.run(['--dir', D, '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'interactive', '--resume', resume, '--docs', doc], { tty: 'y\n' });
  const argv = w.claudeArgv();
  assert.ok(argv, 'claude was called');
  assert.equal(argv.length, 1);
  assert.ok(!argv.includes('-p'));
  assert.match(argv[0], /^Read custom\/install\/ONBOARDING\.md and follow it\./);
  assert.ok(argv[0].includes(path.join(D, 'documents', 'cv', 'resume.md')));
  assert.ok(argv[0].includes(path.join(D, 'documents', 'projects', 'proj.md')));
  assert.ok(w.calls('claude').some((l) => l.includes(`(cwd=${D})`)));
});

test('--yes at a terminal takes onboarding\'s default answer too: Claude Code starts interactively, as --help documents (SW6-scripts-01)', () => {
  const { w, D } = fresh({ keychain: true });
  const resume = md(w, 'resume.md', '# Me\n');
  const r = w.run(['--dir', D, '--yes', '--no-start', '--no-launchd', '--no-h1b-index', '--resume', resume], { tty: '\n' });
  const argv = w.claudeArgv();
  assert.ok(argv, r.out);
  assert.ok(!argv.includes('-p'), argv.join(' '));
  assert.match(argv.at(-1), /ONBOARDING\.md/);
});

test('--yes without a terminal still only prints the onboarding command', () => {
  const { w, D } = fresh({ keychain: true });
  const resume = md(w, 'resume.md', '# Me\n');
  const r = w.run(['--dir', D, '--yes', '--no-start', '--no-launchd', '--no-h1b-index', '--resume', resume]);
  assert.equal(w.claudeArgv(), null, r.out);
  assert.match(r.out, /claude '/);
});

test('--onboard interactive without a usable terminal prints the command and records a pending action instead', () => {
  const { w, D } = fresh({ keychain: true });
  const r = w.run(['--dir', D, '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'interactive']);
  assert.equal(w.calls('claude').length, 0);
  assert.equal(r.status, 3);
});

test('--onboard headless runs a restricted claude -p: dontAsk, read tools plus one Edit rule for the draft dir, no Bash, no MCP servers, token only in the child env and never in its hook or tool children (R11-scripts-b-L3-01)', () => {
  const { w, D } = fresh({ keychain: true });
  const data = path.join(w.T, 'mydata');
  const resume = md(w, 'resume.md', '# Me\n## Skills\n');
  const r = w.run(['--dir', D, '--data-root', data, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless', '--resume', resume], { env: { FAKE_CLAUDE_DRAFTS: '1' } });
  const argv = w.claudeArgv();
  assert.ok(argv, r.out);
  const draft = path.join(data, 'data', 'install', 'onboarding-draft');
  assert.equal(argv[0], '-p');
  assert.ok(argv[1].includes(draft));
  assert.match(argv[1], /Draft mode/);
  assert.doesNotMatch(argv[1], /\{\{/);
  const flag = (name) => argv[argv.indexOf(name) + 1];
  assert.equal(flag('--permission-mode'), 'dontAsk');
  assert.equal(flag('--max-turns'), '40');
  assert.equal(flag('--effort'), 'medium');
  assert.equal(flag('--output-format'), 'text');
  assert.ok(argv.includes('--add-dir') && argv.includes(draft));
  const start = argv.indexOf('--allowedTools') + 1;
  const tools = [];
  for (let i = start; i < argv.length && !argv[i].startsWith('--'); i++) tools.push(argv[i]);
  assert.deepEqual(tools, ['Read', 'Glob', 'Grep', `Edit(/${draft}/**)`]);
  assert.ok(!argv.some((a) => /bash/i.test(a) && !a.includes('\n') && a.length < 40));
  // As the Control Center confines its sessions: no user or project MCP server starts with the token in its env.
  assert.ok(argv.includes('--strict-mcp-config'), argv.join(' '));
  assert.ok(!argv.includes('--mcp-config'), 'no MCP config is handed in');
  const envLine = w.log().find((l) => l.startsWith('claude-env'));
  // SUBPROCESS_ENV_SCRUB: hook and tool children run without the OAuth token.
  assert.equal(envLine, 'claude-env TOKEN_SET=1 API_KEY_EMPTY=1 SUBPROCESS_ENV_SCRUB=1');
  assert.ok(!r.out.includes(SECRET));
  assert.ok(!w.log().some((l) => l.includes(SECRET)));
  for (const log of installLogs(data)) assert.ok(!fs.readFileSync(log, 'utf8').includes(SECRET));
  assert.equal(exists(data, 'config', 'profile.yml'), false);
  assert.equal(exists(data, 'portals.yml'), false);
  assert.equal(exists(data, 'article-digest.md'), false);
  assert.ok(r.out.includes(path.join(draft, 'questions.md')));
  assert.match(r.out, /claude .*Read custom\/install\/ONBOARDING\.md and follow it/);
});

test('--onboard headless hands Claude the Keychain token alone: inherited ANTHROPIC_* variables and credential CLAUDE_CODE_* ones are dropped, settings pass (R32-scripts-b-L2-01)', () => {
  const { w, D } = fresh({ keychain: true });
  const resume = md(w, 'resume.md', '# Me\n');
  const env = {
    ANTHROPIC_BASE_URL: 'https://proxy.example.invalid',
    ANTHROPIC_AUTH_TOKEN: 'other-token',
    ANTHROPIC_CUSTOM_HEADERS: 'X-Key: v',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_CLIENT_CERT: '/tmp/cert.pem',
    CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '1',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096',
  };
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless', '--resume', resume], { env });
  assert.ok(w.claudeArgv(), r.out);
  const inherited = w.log().find((l) => l.startsWith('claude-inherited'));
  assert.ok(inherited, r.out);
  // The same rule as sync.sh, run-daily.sh and the Control Center's isCredential.
  assert.deepEqual(inherited.split(' ').slice(1).sort(), ['CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', 'CLAUDE_CODE_USE_BEDROCK']);
  assert.equal(w.log().find((l) => l.startsWith('claude-env')), 'claude-env TOKEN_SET=1 API_KEY_EMPTY=1 SUBPROCESS_ENV_SCRUB=1');
});

test('--onboard headless confines the tool set itself, so the user\'s own Claude settings (allow rules, hooks) cannot add Bash, network or live writes (R20-scripts-b-L3-01)', () => {
  const { w, D } = fresh({ keychain: true });
  const data = path.join(w.T, 'mydata');
  const resume = md(w, 'resume.md', '# Me\n## Skills\n');
  const r = w.run(['--dir', D, '--data-root', data, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless', '--resume', resume], { env: { FAKE_CLAUDE_DRAFTS: '1' } });
  const argv = w.claudeArgv();
  assert.ok(argv, r.out);
  const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  // --restricted loads no user, project or local settings file, so their allow rules and hooks do not apply.
  assert.ok(argv.includes('--restricted'), argv.join(' '));
  assert.deepEqual(flag('--tools')?.split(','), ['Read', 'Glob', 'Grep', 'Edit', 'Write']);
  const denied = flag('--disallowedTools')?.split(',') ?? [];
  for (const t of ['Bash', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'NotebookEdit', 'PowerShell']) assert.ok(denied.includes(t), `${t} not disallowed: ${denied}`);
  const settings = JSON.parse(flag('--settings') ?? 'null');
  assert.equal(settings?.disableAllHooks, true);
});

test('--onboard headless with a Claude Code that predates --restricted never hands it the token (R20-scripts-b-L3-01)', () => {
  const { w, D } = fresh({ keychain: true });
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless'], { env: { FAKE_CLAUDE_VERSION: '2.1.288' } });
  assert.equal(r.status, 3, r.out);
  assert.equal(w.log().some((l) => l.startsWith('claude -p') || l.startsWith('claude-env')), false, r.out);
  assert.match(r.out, /Headless onboarding needs Claude Code 2\.1\.289 or later/);
});

test('--onboard headless moves an earlier run\'s drafts aside, so only this run\'s drafts are listed and resumed (R15-scripts-b-L1-03)', () => {
  const { w, D } = fresh({ keychain: true });
  const data = path.join(w.T, 'mydata');
  const draft = path.join(data, 'data', 'install', 'onboarding-draft');
  fs.mkdirSync(draft, { recursive: true });
  fs.writeFileSync(path.join(draft, 'article-digest.md'), '# from an earlier run\n');
  const resume = md(w, 'resume.md', '# Me\n## Skills\n');
  const r = w.run(['--dir', D, '--data-root', data, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless', '--resume', resume], { env: { FAKE_CLAUDE_DRAFTS: '1' } });
  assert.ok(w.claudeArgv(), r.out);
  assert.equal(fs.existsSync(path.join(draft, 'article-digest.md')), false, 'the stale draft is still where Resume from drafts reads');
  assert.ok(r.out.includes(path.join(draft, 'questions.md')), r.out);
  assert.doesNotMatch(r.out.slice(r.out.indexOf('Drafts written:')), /article-digest\.md/);
  const kept = fs.readdirSync(path.dirname(draft)).filter((n) => n.startsWith('onboarding-draft.prev-'));
  assert.equal(kept.length, 1, fs.readdirSync(path.dirname(draft)).join(', '));
  assert.equal(fs.readFileSync(path.join(path.dirname(draft), kept[0], 'article-digest.md'), 'utf8'), '# from an earlier run\n');
  assert.ok(r.out.includes(path.join(path.dirname(draft), kept[0])), 'the user is told where the earlier drafts went');
});

test('--onboard headless with a Claude Code too old to scrub hook and tool children never hands it the token (R11-scripts-b-L3-01)', () => {
  for (const version of ['2.1.287', 'garbled']) {
    const { w, D } = fresh({ keychain: true });
    const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless'], { env: { FAKE_CLAUDE_VERSION: version } });
    assert.equal(r.status, 3, r.out);
    assert.equal(w.log().some((l) => l.startsWith('claude -p') || l.startsWith('claude-env')), false, `${version}: claude -p ran\n${r.out}`);
    assert.match(r.out, /Headless onboarding needs Claude Code 2\.1\.289 or later/, version);
    assert.match(r.out, /claude update/, version);
    // claude update can land on a version the contract has not approved yet: name one that passes, when it can be read.
    assert.match(r.out, /claude install 2\.1\.289/, version);
  }
});

/** Rewrites the approved Claude Code versions in the contract every checkout this world makes is cloned from. */
const approveClaude = (w, versions) => fs.writeFileSync(path.join(w.fakeSrc, 'custom/control-center/server/core/contract.json'), JSON.stringify({ claude: { approvedVersions: versions } }));

test('--onboard headless with a newer Claude Code the contract does not approve never hands it the token and prints the interactive command (R20 FU-scripts-02)', () => {
  const { w, D } = fresh({ keychain: true });
  approveClaude(w, ['2.1.289']);
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless'], { env: { FAKE_CLAUDE_VERSION: '2.1.300' } });
  assert.equal(r.status, 3, r.out);
  assert.equal(w.log().some((l) => l.startsWith('claude -p') || l.startsWith('claude-env')), false, r.out);
  assert.match(r.out, /Headless onboarding runs only on a Claude Code version the Control Center approves \(approved: 2\.1\.289; found: 2\.1\.300\)/);
  assert.match(r.out, /claude install 2\.1\.289/);
  assert.doesNotMatch(r.out, /unexpected failure/, 'a refusal is not a crash');
  assert.match(r.out, /Or run: cd .* && claude /);
});

test('--onboard headless with a contract that approves no version yet says so, and names no command that installs one (R20 FU-scripts-02 review)', () => {
  const { w, D } = fresh({ keychain: true });
  approveClaude(w, []);
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless'], { env: { FAKE_CLAUDE_VERSION: '2.1.300' } });
  assert.equal(r.status, 3, r.out);
  assert.equal(w.log().some((l) => l.startsWith('claude -p') || l.startsWith('claude-env')), false, r.out);
  assert.match(r.out, /approved: none yet; found: 2\.1\.300/);
  assert.match(r.out, /No Claude Code version is approved for headless onboarding yet/);
  assert.doesNotMatch(r.out, /claude install|probe:reads|installs an approved one/);
  assert.match(r.out, /yet\. Run: cd .* && claude /);
});

test('--onboard headless names the newest approved version that meets the headless floor, never one below it (R20 FU-scripts-02 review)', () => {
  for (const [approved, expected] of [[['2.1.200', '2.1.295', '2.1.289'], '2.1.295'], [['2.1.289', '2.1.296-beta.1'], '2.1.296-beta.1'], [['2.1.296-beta.1', '2.1.296'], '2.1.296'], [['2.1.289-beta.1'], null], [['2.1.200'], null]]) {
    const { w, D } = fresh({ keychain: true });
    approveClaude(w, approved);
    const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless'], { env: { FAKE_CLAUDE_VERSION: '2.1.300' } });
    assert.equal(r.status, 3, r.out);
    assert.equal(w.log().some((l) => l.startsWith('claude -p') || l.startsWith('claude-env')), false, r.out);
    const named = [...r.out.matchAll(/claude install (\S+?)[),]/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(named)], expected ? [expected] : [], `${approved}: ${r.out}`);
    if (!expected) assert.match(r.out, /No approved Claude Code version meets 2\.1\.289 yet/, r.out);
  }
});

test('--onboard headless runs an approved pre-release Claude Code above the floor (R30-scripts-b-X-01)', () => {
  const { w, D } = fresh({ keychain: true });
  approveClaude(w, ['2.1.296-beta.1']);
  const data = path.join(w.T, 'mydata');
  const resume = md(w, 'resume.md', '# Me\n## Skills\n');
  const r = w.run(['--dir', D, '--data-root', data, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless', '--resume', resume], { env: { FAKE_CLAUDE_VERSION: '2.1.296-beta.1', FAKE_CLAUDE_DRAFTS: '1' } });
  assert.doesNotMatch(r.out, /Headless onboarding needs Claude Code/, r.out);
  assert.equal(w.claudeArgv()?.[0], '-p', r.out);
});

test('--onboard headless with a too-old Claude Code the contract lists still names an approved version new enough (R20 FU-scripts-02 review)', () => {
  const { w, D } = fresh({ keychain: true });
  approveClaude(w, ['2.1.287', '2.1.289']);
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless'], { env: { FAKE_CLAUDE_VERSION: '2.1.287' } });
  assert.equal(r.status, 3, r.out);
  assert.equal(w.log().some((l) => l.startsWith('claude -p') || l.startsWith('claude-env')), false, r.out);
  assert.match(r.out, /claude install 2\.1\.289 installs an approved one/);
});

test('--onboard headless runs the exact binary it approved, resolved past any symlink, with the autoupdater off (R20 FU-scripts-02 review)', () => {
  const { w, D } = fresh({ keychain: true });
  const data = path.join(w.T, 'mydata');
  const resume = md(w, 'resume.md', '# Me\n## Skills\n');
  const r = w.run(['--dir', D, '--data-root', data, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless', '--resume', resume], { env: { FAKE_CLAUDE_DRAFTS: '1' } });
  assert.equal(w.claudeArgv()?.[0], '-p', r.out);
  // bin/claude is a symlink, as ~/.local/bin/claude is: an update re-points it, so the run starts the file it checked.
  assert.deepEqual(w.log().filter((l) => l.startsWith('claude-bin ')), [`claude-bin ${fs.realpathSync(path.join(w.bin, 'claude'))} DISABLE_AUTOUPDATER=1`]);
});

test('--onboard headless checks the approved binary again right before the run, so one updated in place since is refused (R20 FU-scripts-02 review)', () => {
  const { w, D } = fresh({ keychain: true });
  // Two --version calls pass (the floor and the gate); from the third on, the same file reports an unapproved version.
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless'], { env: { FAKE_CLAUDE_LATER_VERSION: '2.1.300', FAKE_CLAUDE_LATER_AFTER: '2' } });
  assert.equal(w.calls('claude --version').length, 3, r.out);
  assert.equal(r.status, 3, r.out);
  assert.equal(w.log().some((l) => l.startsWith('claude -p') || l.startsWith('claude-env')), false, r.out);
  assert.match(r.out, /Claude Code changed while onboarding was being prepared/);
});

test('--onboard headless with a too-old Claude Code and a contract that approves nothing yet points at the interactive command (R20 FU-scripts-02 review)', () => {
  const { w, D } = fresh({ keychain: true });
  approveClaude(w, []);
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless'], { env: { FAKE_CLAUDE_VERSION: '2.1.287' } });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /no Claude Code version is approved for headless onboarding yet, so until one is run the interactive command/);
});

test('--onboard headless runs on a newer Claude Code once the checkout\'s contract approves it, read at run time (R20 FU-scripts-02)', () => {
  const { w, D } = fresh({ keychain: true });
  approveClaude(w, ['2.1.289', '2.1.300']);
  const data = path.join(w.T, 'mydata');
  const resume = md(w, 'resume.md', '# Me\n## Skills\n');
  const r = w.run(['--dir', D, '--data-root', data, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless', '--resume', resume], { env: { FAKE_CLAUDE_VERSION: '2.1.300', FAKE_CLAUDE_DRAFTS: '1' } });
  assert.equal(w.claudeArgv()?.[0], '-p', r.out);
  assert.ok(w.claudeArgv().includes('--restricted'));
  assert.ok(r.out.includes(path.join(data, 'data', 'install', 'onboarding-draft', 'questions.md')), r.out);
});

test('--onboard headless still runs on an approved Claude Code when node writes a warning to stderr (R20 FU-scripts-02 review)', () => {
  const { w, D } = fresh({ keychain: true });
  const data = path.join(w.T, 'mydata');
  const resume = md(w, 'resume.md', '# Me\n## Skills\n');
  // Stands in for a NODE_OPTIONS warning or a deprecation notice from every node the installer runs.
  const warn = `--import=data:text/javascript,process.stderr.write(${encodeURIComponent(JSON.stringify('(node) warning: stand-in\n'))})`;
  const r = w.run(['--dir', D, '--data-root', data, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless', '--resume', resume], { env: { FAKE_CLAUDE_DRAFTS: '1', NODE_OPTIONS: warn } });
  assert.equal(w.claudeArgv()?.[0], '-p', r.out);
});

test('--onboard headless with a checkout whose contract cannot be read never hands claude the token and says what to do (R20 FU-scripts-02)', () => {
  const { w, D } = fresh({ keychain: true });
  fs.rmSync(path.join(w.fakeSrc, 'custom/control-center/server/core/contract.json'));
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless']);
  assert.equal(r.status, 3, r.out);
  assert.equal(w.log().some((l) => l.startsWith('claude -p') || l.startsWith('claude-env')), false, r.out);
  assert.match(r.out, /Headless onboarding could not read the approved Claude Code versions/);
  assert.doesNotMatch(r.out, /unexpected failure/, 'a refusal is not a crash');
  assert.match(r.out, /Or run: cd .* && claude /);
});

test('--onboard headless without the Keychain item is a pending action (exit 3) and claude is not called', () => {
  const { w, D } = fresh({ keychain: false });
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless']);
  assert.equal(r.status, 3);
  assert.equal(w.claudeArgv(), null);
  assert.match(r.out, /Keychain/);
});

// The Keychain token as headless onboarding reads it: trimmed, and with the security exit code checked, as the
// Control Center, the daily job and the weekly sync read the same item (R23-scripts-b-L2-01, R23-scripts-b-L3-01).
function headlessRun(env) {
  const { w, D } = fresh({ keychain: true });
  const resume = md(w, 'resume.md', '# Me\n');
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless', '--resume', resume], { env });
  const ran = w.log().some((l) => l.startsWith('claude -p') || l.startsWith('claude-env'));
  assert.doesNotMatch(r.out, /unexpected failure/, 'a refused Keychain read is not a crash');
  return { w, r, ran };
}

test('--onboard headless hands claude the Keychain token trimmed, as the Control Center and the daily job read it (R23-scripts-b-L2-01)', () => {
  const { w, r } = headlessRun({ FAKE_SECURITY_TOKEN: ` ${SECRET} \r` });
  assert.ok(w.log().includes(`claude-token-len ${SECRET.length}`), `${w.log().join('\n')}\n${r.out}`);
  assert.ok(!r.out.includes(SECRET));
});

test('--onboard headless with a Keychain item it cannot read (locked, exit 36) never starts claude and says to unlock it (R23-scripts-b-L3-01)', () => {
  const { r, ran } = headlessRun({ FAKE_SECURITY_READ_EXIT: '36' });
  assert.equal(ran, false, r.out);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /Could not read Keychain item career-ops-claude-token: security failed \(exit 36: security: SecKeychainSearchCopyNext: User interaction is not allowed\.\)\. The login keychain is probably locked or cannot prompt \(for example over SSH or before login\)\. Unlock it with: security unlock-keychain, then re-run with --onboard headless\./);
  assert.doesNotMatch(r.out, /did not finish cleanly/);
  assert.doesNotMatch(r.out, /not found/);
});

test('--onboard headless with access to the Keychain item denied (exit 51) never starts claude and says how to allow it (R23-scripts-b-L3-01)', () => {
  const { r, ran } = headlessRun({ FAKE_SECURITY_READ_EXIT: '51' });
  assert.equal(ran, false, r.out);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /Could not read Keychain item career-ops-claude-token: security failed \(exit 51[^)]*\)\. Access to it was denied: answer Always Allow when the Keychain prompt appears, or add \/usr\/bin\/security to the item's access control in Keychain Access, then re-run with --onboard headless\./);
});

test('--onboard headless whose Keychain read finds no item (exit 44) or only whitespace never starts claude and says to store the token (R23-scripts-b-L2-01)', () => {
  for (const env of [{ FAKE_SECURITY_READ_EXIT: '44' }, { FAKE_SECURITY_TOKEN: ' \t ' }]) {
    const { r, ran } = headlessRun(env);
    assert.equal(ran, false, r.out);
    assert.equal(r.status, 3, r.out);
    assert.match(r.out, /Keychain item career-ops-claude-token not found\. Run: claude setup-token, then security add-generic-password -U -a "\$USER" -s career-ops-claude-token -w/);
    assert.doesNotMatch(r.out, /Could not read/);
  }
});

test('--onboard headless gives a Keychain read that waits on an unanswered unlock prompt CC_KEYCHAIN_TIMEOUT seconds, then refuses (R23-scripts-b-L3-01)', () => {
  const { r, ran } = headlessRun({ FAKE_SECURITY_READ_HANG: '30', CC_KEYCHAIN_TIMEOUT: '1' });
  assert.equal(ran, false, r.out);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /Could not read Keychain item career-ops-claude-token: security did not answer within 1 s\. The login keychain is probably locked and waiting at an unlock prompt nobody answered\. Unlock it with: security unlock-keychain, then re-run with --onboard headless\./);
});

test('--onboard headless whose Keychain read fails leaves an earlier run\'s drafts where Resume from drafts reads them (R23-scripts-b-L3-01 review)', () => {
  const { w, D } = fresh({ keychain: true });
  const data = path.join(w.T, 'mydata');
  const draft = path.join(data, 'data', 'install', 'onboarding-draft');
  fs.mkdirSync(draft, { recursive: true });
  fs.writeFileSync(path.join(draft, 'article-digest.md'), '# from an earlier run\n');
  const resume = md(w, 'resume.md', '# Me\n');
  const r = w.run(['--dir', D, '--data-root', data, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless', '--resume', resume], { env: { FAKE_SECURITY_READ_EXIT: '36' } });
  assert.equal(w.log().some((l) => l.startsWith('claude -p') || l.startsWith('claude-env')), false, r.out);
  assert.match(r.out, /Could not read Keychain item career-ops-claude-token/);
  assert.equal(fs.readFileSync(path.join(draft, 'article-digest.md'), 'utf8'), '# from an earlier run\n');
  assert.deepEqual(fs.readdirSync(path.dirname(draft)).filter((n) => n.startsWith('onboarding-draft.prev-')), []);
  assert.doesNotMatch(r.out, /Moved the drafts/);
});

test('--onboard headless refused because Claude Code changed in place leaves an earlier run\'s drafts where Resume from drafts reads them (R33-scripts-b-L1-01)', () => {
  const { w, D } = fresh({ keychain: true });
  const data = path.join(w.T, 'mydata');
  const draft = path.join(data, 'data', 'install', 'onboarding-draft');
  fs.mkdirSync(draft, { recursive: true });
  fs.writeFileSync(path.join(draft, 'article-digest.md'), '# from an earlier run\n');
  const resume = md(w, 'resume.md', '# Me\n');
  const r = w.run(['--dir', D, '--data-root', data, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless', '--resume', resume], { env: { FAKE_CLAUDE_LATER_VERSION: '2.1.300', FAKE_CLAUDE_LATER_AFTER: '2' } });
  assert.equal(w.log().some((l) => l.startsWith('claude -p') || l.startsWith('claude-env')), false, r.out);
  assert.match(r.out, /Claude Code changed while onboarding was being prepared/);
  assert.equal(fs.readFileSync(path.join(draft, 'article-digest.md'), 'utf8'), '# from an earlier run\n');
  assert.deepEqual(fs.readdirSync(path.dirname(draft)).filter((n) => n.startsWith('onboarding-draft.prev-')), []);
  assert.doesNotMatch(r.out, /Moved the drafts/);
});

test('a token the headless read finds empty or cannot read keeps the daily job and the Control Center off, as step 7 would (R23-scripts-b-L2-01 review)', () => {
  for (const [env, why] of [[{ FAKE_SECURITY_TOKEN: ' ' }, /The Keychain item is missing, so the job would fail every morning/], [{ FAKE_SECURITY_READ_EXIT: '36' }, /The Keychain item could not be read, so the job would fail every morning/]]) {
    const { w, D } = fresh({ keychain: true });
    w.makeCheckout(D, { files: READY_FILES });
    const r = w.run(['--dir', D, '--non-interactive', '--no-h1b-index', '--onboard', 'headless'], { env });
    assert.equal(r.status, 3, r.out);
    assert.equal(w.log().some((l) => l.startsWith('claude -p') || l.startsWith('claude-env')), false, r.out);
    assert.match(r.out, why);
    assert.equal(w.calls('launchd-install').length, 0, r.out);
    assert.equal(w.calls('cc').length, 0, r.out);
  }
});

test('an empty CC_KEYCHAIN_TIMEOUT means the default, as the daily job and the weekly sync read it', () => {
  const { w, D } = fresh({ keychain: true });
  const r = w.run(['--dir', D, '--non-interactive', ...QUIET], { env: { CC_KEYCHAIN_TIMEOUT: '' } });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Keychain item career-ops-claude-token exists \(not read\)/);
});

test('a core-only install never reads the Keychain, so a stray CC_KEYCHAIN_TIMEOUT does not stop it', () => {
  const { w, D } = fresh({ keychain: true });
  const r = w.run(['--dir', D, '--non-interactive', '--core-only', '--no-h1b-index', '--onboard', 'none'], { env: { FAKE_UNAME: 'Linux', CC_KEYCHAIN_TIMEOUT: 'abc' } });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /CC_KEYCHAIN_TIMEOUT/);
});

test('a CC_KEYCHAIN_TIMEOUT that is not 1 to 3600 whole seconds is a usage error before anything changes', () => {
  for (const value of ['0', 'abc', '3601', '1.5']) {
    const { w, D } = fresh({ keychain: true });
    const before = w.snapshot();
    const r = w.run(['--dir', D, '--non-interactive', ...QUIET], { env: { CC_KEYCHAIN_TIMEOUT: value } });
    assert.equal(r.status, 2, `${value}: ${r.out}`);
    assert.match(r.out, new RegExp(`CC_KEYCHAIN_TIMEOUT must be a whole number of seconds from 1 to 3600, not '${value.replace('.', '\\.')}'\\.`));
    assert.deepEqual(w.snapshot(), before, value);
  }
});

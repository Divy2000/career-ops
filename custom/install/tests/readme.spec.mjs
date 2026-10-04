import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const README_REL = '.github/README.md';
const ONBOARDING_REL = 'custom/install/ONBOARDING.md';
const INSTALL_SH = path.join(ROOT, 'custom/install/install.sh');
const EM_DASH = String.fromCharCode(0x2014);

const readme = readFileSync(path.join(ROOT, README_REL), 'utf8');
const onboarding = readFileSync(path.join(ROOT, ONBOARDING_REL), 'utf8');

// The frozen installer flag contract (plan addendum). The README may only use these.
const FROZEN_FLAGS = [
  '--yes', '--non-interactive', '--dir', '--data-root', '--ref', '--no-launchd', '--with-upstream-sync',
  '--no-start', '--no-h1b-index', '--resume', '--docs', '--replace-cv', '--onboard', '--install-missing',
  '--core-only', '--dry-run', '--help',
];

function stripCode(markdown) {
  return markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '').replace(/`[^`\n]*`/g, '');
}

function headings(markdown) {
  const out = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) out.push({ level: m[1].length, text: m[2] });
  }
  return out;
}

function githubSlug(text) {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

function linkTargets(markdown) {
  const text = stripCode(markdown);
  const targets = [];
  for (const m of text.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) targets.push(m[1]);
  for (const m of text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)) targets.push(m[1]);
  for (const m of text.matchAll(/<(?:a|img)\b[^>]*?\b(?:href|src)=["']([^"']+)["']/gi)) targets.push(m[1]);
  return targets;
}

// GitHub resolves paths case-sensitively; macOS and Windows file systems do not.
function existsExactCase(rel) {
  let dir = ROOT;
  for (const segment of rel.split('/').filter(Boolean)) {
    if (!readdirSync(dir).includes(segment)) return false;
    dir = path.join(dir, segment);
  }
  return existsSync(dir);
}

function section(markdown, titlePattern) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^#{2,3}\s/.test(l) && titlePattern.test(l));
  assert.notEqual(start, -1, `no heading matching ${titlePattern}`);
  const level = lines[start].match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

function fencedBlocks(markdown) {
  return [...markdown.matchAll(/^(```|~~~)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm)].map((m) => m[2]);
}

test('every link and image in the README is repo-root relative (leading slash) and resolves', () => {
  const problems = [];
  const slugs = new Set(headings(readme).map((h) => githubSlug(h.text)));
  for (const raw of linkTargets(readme)) {
    if (/^(https?:\/\/|mailto:)/i.test(raw)) continue;
    if (raw.startsWith('#')) {
      if (!slugs.has(raw.slice(1))) problems.push(`${raw}: no such heading in the README`);
      continue;
    }
    if (!raw.startsWith('/')) { problems.push(`${raw}: must start with "/" (the README lives in .github/)`); continue; }
    const rel = decodeURIComponent(raw.split('#')[0].split('?')[0]).replace(/^\/+/, '');
    if (!existsExactCase(rel)) problems.push(`${raw}: ${rel} does not exist in the repo`);
  }
  assert.deepEqual(problems, []);
});

test('the README has at least the links to the fork docs, the licence and the trademark policy', () => {
  const targets = new Set(linkTargets(readme));
  for (const required of ['/custom/README.md', '/custom/control-center/README.md', '/LICENSE', '/TRADEMARK.md', '/custom/install/ONBOARDING.md']) {
    assert.ok(targets.has(required), `missing link to ${required}`);
  }
});

test('the README and ONBOARDING.md contain no em dash', () => {
  assert.equal(readme.includes(EM_DASH), false);
  assert.equal(onboarding.includes(EM_DASH), false);
});

test('the README and ONBOARDING.md hold no personal data', () => {
  for (const [name, text] of [['README', readme], ['ONBOARDING', onboarding]]) {
    assert.equal(/\/Users\/[^\s/<>]+/.test(text.replace(/\/Users\/<[^>]+>/g, '')), false, `${name}: absolute home path`);
    assert.equal(/\/home\/[a-z][^\s/<>]*/i.test(text.replace(/\/home\/<[^>]+>/g, '')), false, `${name}: absolute home path`);
    const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
    const real = emails.filter((e) => !/@(example\.(com|org|net)|example\.invalid)$/i.test(e) && !/^noreply@/i.test(e));
    assert.deepEqual(real, [], `${name}: email addresses must be example.com placeholders`);
    assert.equal(/\b\+?1?[-. ]?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/.test(text), false, `${name}: phone number`);
    assert.equal(/divypatel|gmail\.com|outlook\.com/i.test(text), false, `${name}: personal identifier`);
  }
});

test('Option 1 (the Claude Code prompt) comes before Option 2 (the install script)', () => {
  const titles = headings(readme).map((h) => h.text);
  const one = titles.findIndex((t) => /^Option 1\b/.test(t));
  const two = titles.findIndex((t) => /^Option 2\b/.test(t));
  assert.ok(one !== -1 && two !== -1, `headings: ${titles.join(' | ')}`);
  assert.ok(one < two);
  assert.match(titles[one], /recommended/i);
  assert.match(titles[one], /Claude Code/);
  assert.match(titles[two], /script/i);
});

test('Option 1 prompt is copy-paste ready: plan first, pinned tag, installer flags, user-run Keychain step, ONBOARDING.md', () => {
  const opt1 = section(readme, /^#{2,3}\s+Option 1\b/);
  const prompt = fencedBlocks(opt1).find((b) => /fork-install-v1/.test(b));
  assert.ok(prompt, 'Option 1 needs a fenced prompt that names the pinned tag fork-install-v1');
  assert.match(prompt, /plan/i);
  assert.match(prompt, /ask me/i);
  assert.match(prompt, /git clone[^\n]*fork-install-v1|fork-install-v1[^\n]*clone/i);
  assert.match(prompt, /custom\/install\/install\.sh --non-interactive --no-start --no-launchd --onboard none/);
  assert.match(prompt, /Keychain/);
  assert.match(prompt, /my own terminal|my terminal/i);
  assert.match(prompt, /custom\/install\/ONBOARDING\.md/);
  assert.match(prompt, /any format/i);
  assert.match(opt1, /any format/i);
});

test('Option 2 states the Markdown-only rule, the size limits and what happens to cv.md', () => {
  const opt2 = section(readme, /^#{2,3}\s+Option 2\b/);
  assert.match(opt2, /--resume resume\.md/);
  assert.match(opt2, /--docs/);
  assert.match(opt2, /Markdown/);
  assert.match(opt2, /\.md/);
  assert.match(opt2, /Option 1/, 'points PDF and DOCX users back to option 1');
  assert.match(opt2, /PDF/);
  assert.match(opt2, /1 MiB/);
  assert.match(opt2, /2 MiB/);
  assert.match(opt2, /\b20\b/);
  assert.match(opt2, /cv\.md/);
  assert.match(opt2, /--replace-cv/);
  assert.match(opt2, /backup/i);
  assert.match(opt2, /fork-install-v1/);
});

test('the README uses only flags from the frozen installer contract on install.sh command lines and in the flags table', () => {
  const used = new Set();
  const cmdLines = [];
  for (const block of fencedBlocks(readme)) {
    const joined = block.replace(/\\\n\s*/g, ' ');
    for (const line of joined.split('\n')) if (/install\.sh|bootstrap\.sh/.test(line)) cmdLines.push(line);
  }
  for (const line of cmdLines) for (const m of line.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*)/g)) used.add(m[1]);
  for (const m of readme.matchAll(/^\|\s*`(--[a-z][a-z0-9-]*)/gm)) used.add(m[1]);
  assert.ok(used.size >= 8, `expected a flags table and command lines, found ${[...used].join(' ')}`);
  const unknown = [...used].filter((f) => !FROZEN_FLAGS.includes(f));
  assert.deepEqual(unknown, []);
  for (const needed of ['--resume', '--docs', '--replace-cv', '--onboard', '--dry-run', '--non-interactive', '--no-start', '--no-launchd', '--yes', '--data-root', '--with-upstream-sync']) {
    assert.ok(used.has(needed), `README never mentions ${needed}`);
  }
});

test('every flag the README mentions exists in install.sh --help', () => {
  assert.ok(existsSync(INSTALL_SH), 'custom/install/install.sh must exist');
  const help = spawnSync('bash', [INSTALL_SH, '--help'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(help.status, 0, help.stderr);
  const text = help.stdout + help.stderr;
  const used = new Set();
  for (const block of fencedBlocks(readme)) {
    for (const line of block.replace(/\\\n\s*/g, ' ').split('\n')) {
      if (/install\.sh/.test(line)) for (const m of line.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*)/g)) used.add(m[1]);
    }
  }
  for (const m of readme.matchAll(/^\|\s*`(--[a-z][a-z0-9-]*)/gm)) used.add(m[1]);
  const missing = [...used].filter((f) => !text.includes(f));
  assert.deepEqual(missing, []);
});

test('the README outline follows the plan and ends with credits, licence and the unofficial-fork note', () => {
  const titles = headings(readme).filter((h) => h.level === 2).map((h) => h.text);
  const order = [
    /^Who it is for/i, /^Quick start/i, /^What you get/i, /^Safety model/i, /^Requirements/i,
    /^First run/i, /^Daily use/i, /^Updating/i, /^Uninstall/i, /^Troubleshooting/i, /^Links/i, /^Credits/i,
  ];
  let at = -1;
  for (const re of order) {
    const i = titles.findIndex((t, idx) => idx > at && re.test(t));
    assert.ok(i > at, `section ${re} missing or out of order in: ${titles.join(' | ')}`);
    at = i;
  }
  assert.match(headings(readme)[0].text, /fork of career-ops/i);
});

test('the README is an unofficial fork under the trademark policy: no affiliation or endorsement claims', () => {
  assert.match(readme, /unofficial fork/i);
  assert.match(readme, /not affiliated/i);
  assert.match(readme, /not endorsed|no endorsement|does not endorse/i);
  assert.match(readme, /\/TRADEMARK\.md/);
  assert.match(readme, /MIT/);
  for (const banned of [/Powered by career-ops/i, /Official career-ops/i, /career-ops (Cloud|Pro|SaaS|Certified|Verified)\b/i]) {
    assert.equal(banned.test(readme), false, `banned phrase ${banned}`);
  }
});

test('the README discloses the hardcoded backend/AI priority and the macOS requirement', () => {
  assert.match(readme, /backend/i);
  assert.match(readme, /PRIORITY_TITLE|hardcoded/i);
  assert.match(readme, /macOS/);
  assert.match(readme, /Node(\.js)? (>= ?|22\.6)/i);
});

test('the README warns not to run update-system apply and not to use npx init for this fork', () => {
  assert.match(readme, /update-system\.mjs apply/);
  assert.match(readme, /@santifer\/career-ops/);
});

test('ONBOARDING.md has the Draft mode and Resume from drafts sections', () => {
  const titles = headings(onboarding).map((h) => h.text);
  assert.ok(titles.includes('Draft mode'), titles.join(' | '));
  assert.ok(titles.includes('Resume from drafts'), titles.join(' | '));
  const draft = section(onboarding, /^#{2,3}\s+Draft mode$/);
  assert.match(draft, /data\/install\/onboarding-draft/);
  assert.match(draft, /questions\.md/);
  assert.match(draft, /cv\.md/);
  const resume = section(onboarding, /^#{2,3}\s+Resume from drafts$/);
  assert.match(resume, /data\/install\/onboarding-draft/);
  assert.match(resume, /questions\.md/);
});

test('ONBOARDING.md names the exact commands, files and gates the procedure depends on', () => {
  for (const needle of [
    'node doctor.mjs --json', 'node intake.mjs --commit', 'node intake.mjs --text', 'config/profile.yml', 'modes/_profile.md',
    'modes/_brief.md', 'portals.yml', 'article-digest.md', 'data/applications.md', 'data/blacklist.md', 'modes/_custom.md',
    'pdftotext -layout', 'textutil -convert txt -stdout', 'sips -s format png', 'explicit yes', 'evidence',
    'onboardingNeeded', 'unpersonalized', 'needs_sponsorship', 'authorized_in', 'visa_status', 'spend_tier',
    'custom/launchd/install.sh --jobs daily', 'MANIFESTO', 'Connections.csv',
  ]) {
    assert.ok(onboarding.includes(needle), `ONBOARDING.md never mentions ${needle}`);
  }
});

test('profile.yml keys that ONBOARDING.md tells the agent to fill exist in config/profile.example.yml', () => {
  const example = readFileSync(path.join(ROOT, 'config/profile.example.yml'), 'utf8');
  for (const key of ['full_name', 'email', 'location', 'target_roles', 'primary', 'archetypes', 'narrative', 'compensation', 'target_range', 'minimum', 'visa_status', 'authorized_in', 'needs_sponsorship', 'language', 'output', 'spend_tier']) {
    assert.ok(new RegExp(`^\\s*#?\\s*${key}:`, 'm').test(example), `${key} is not in profile.example.yml`);
    assert.ok(onboarding.includes(key), `ONBOARDING.md never mentions ${key}`);
  }
});

test('the blacklist format in ONBOARDING.md matches the parser: a Company | Since | Scope | Reason table', () => {
  assert.match(onboarding, /\| Company \| Since \| Scope \| Reason \|/);
  assert.match(onboarding, /company/);
  assert.match(onboarding, /domain/);
});

test('every link in ONBOARDING.md resolves relative to its own file or the repo root', () => {
  const problems = [];
  for (const raw of linkTargets(onboarding)) {
    if (/^(https?:\/\/|mailto:|#)/i.test(raw)) continue;
    const rel = raw.startsWith('/') ? raw.slice(1) : path.posix.join(path.posix.dirname(ONBOARDING_REL), raw);
    if (!existsExactCase(decodeURIComponent(rel.split('#')[0]))) problems.push(raw);
  }
  assert.deepEqual(problems, []);
});

test('custom/README.md points to the installer, the landing README and the onboarding procedure', () => {
  const custom = readFileSync(path.join(ROOT, 'custom/README.md'), 'utf8');
  assert.match(custom, /custom\/install\/install\.sh/);
  assert.match(custom, /\.github\/README\.md/);
  assert.match(custom, /ONBOARDING\.md/);
  assert.match(custom, /upstream-sync/);
  assert.equal(custom.includes(EM_DASH), false);
});

test('the Control Center README describes the theme as light, dark or auto, not as a dark-mode app', () => {
  const cc = readFileSync(path.join(ROOT, 'custom/control-center/README.md'), 'utf8');
  assert.equal(/dark-mode web app/i.test(cc), false);
  assert.match(cc, /light, dark or auto/i);
});

test('Option 1 tells users that exit 3 with pending actions is expected until onboarding finishes', () => {
  const opt1 = section(readme, /^#{2,3}\s+Option 1\b/);
  assert.match(opt1, /exit(s|ed)? (code )?3/i);
  assert.match(opt1, /onboarding/i);
  assert.match(opt1, /Keychain/);
});

test('the README says what a missing Keychain item skips and how --resume and --docs paths resolve', () => {
  const opt2 = section(readme, /^#{2,3}\s+Option 2\b/);
  assert.match(opt2, /current (working )?directory/i);
  assert.match(readme, /Keychain[^\n]*(daily job|launchd)[^\n]*Control Center|Control Center[^\n]*daily job[^\n]*Keychain/i);
});

test('the README does not claim a --ref default and describes --dir as the installer does', () => {
  assert.equal(/--ref[^\n]*default/i.test(readme), false);
  assert.match(readme, /`--dir <path>`[^\n]*the checkout the script is in/i);
});

test('ONBOARDING.md appends the shipped sponsorship template file instead of embedding a copy', () => {
  const tpl = path.join(ROOT, 'custom/install/templates/_custom-sponsorship.md');
  assert.ok(existsSync(tpl), 'template file missing');
  assert.ok(readFileSync(tpl, 'utf8').startsWith('### Sponsorship check'));
  assert.ok(onboarding.includes('custom/install/templates/_custom-sponsorship.md'));
  assert.equal(/^### Sponsorship check/m.test(onboarding), false, 'ONBOARDING.md must not embed its own copy of the section');
});

test('ONBOARDING.md numbers the gate as its own step and every Step reference points at a real step', () => {
  const stepHeads = headings(onboarding).filter((h) => /^Step \d+:/.test(h.text));
  assert.deepEqual(stepHeads.map((h) => Number(h.text.match(/^Step (\d+)/)[1])), [1, 2, 3, 4, 5, 6, 7]);
  assert.match(stepHeads[4].text, /^Step 5: The gate$/);
  assert.match(stepHeads[5].text, /^Step 6: Verify and record$/);
  assert.match(stepHeads[6].text, /^Step 7: Offers$/);
  assert.equal(headings(onboarding).some((h) => h.text === 'The gate'), false, 'the unnumbered gate heading must be gone');
  const text = stripCode(onboarding);
  for (const m of text.matchAll(/\bStep (\d+)\b/g)) assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= 7, `Step ${m[1]} does not exist`);
  assert.match(section(onboarding, /^#{2,3}\s+Step 4\b/), /Step 5/);
  assert.match(section(onboarding, /^#{2,3}\s+Resume from drafts$/), /Step 5/);
  assert.match(onboarding, /\(see "Step 5: The gate"\)/);
});

test('ONBOARDING.md rule 5 allows staging copies and extracted text before the gate, lists them, and cleans up on decline', () => {
  const rule5 = onboarding.split('\n').find((l) => /^5\. /.test(l));
  assert.ok(rule5);
  assert.match(rule5, /staging/i);
  assert.match(rule5, /documents\//);
  assert.match(rule5, /\.extracted\.txt/);
  assert.match(rule5, /temp/i);
  assert.match(rule5, /data\/install\/onboarding-draft\//);
  assert.match(rule5, /list/i);
  assert.match(rule5, /cv\.md/);
  assert.match(rule5, /config/);
  assert.match(rule5, /modes/);
  assert.match(rule5, /portals/);
  assert.match(rule5, /data\//);
  assert.match(rule5, /declin/i);
  assert.match(rule5, /delete/i);
  assert.match(rule5, /pre-existing set/i, 'decline cleanup is bounded by the pre-existing set');
  const gate = section(onboarding, /^#{2,3}\s+Step 5: The gate$/);
  assert.match(gate, /delete only the files labelled `created this session`/i);
  assert.match(gate, /onboarding-draft/);
});

test('the ONBOARDING.md image row creates its temp dir and uses an absolute path under the effective data root', () => {
  assert.match(onboarding, /getCareerOpsRoot/);
  assert.match(onboarding, /mkdir -p "\$DATA\/data\/install\/tmp"/);
  assert.match(onboarding, /--out "\$DATA\/data\/install\/tmp\//);
  assert.equal(/--out data\/install\/tmp/.test(onboarding), false);
});

test('Updating pulls main and reruns the installer without re-enabling the job or the H-1B index, and explains how to opt in', () => {
  const updating = section(readme, /^#{2,3}\s+Updating$/);
  const installLine = updating.split('\n').find((l) => /install\.sh/.test(l));
  assert.ok(installLine);
  assert.match(installLine, /--no-launchd/);
  assert.match(installLine, /--no-h1b-index/);
  assert.match(installLine, /--no-start/);
  assert.match(updating, /git switch main/);
  assert.match(updating, /git pull --ff-only/);
  assert.match(updating, /custom\/launchd\/install\.sh --jobs daily/);
  assert.match(updating, /plugins\.mjs enable h1b-sponsor --confirm/);
});

test('the README says pending actions print before the Control Center starts and exit 3 applies when it does not start', () => {
  assert.match(readme, /printed before the Control Center starts/i);
  assert.match(readme, /exit 3 only shows up when it does not start/i);
  assert.match(readme, /--no-start/);
  const opt1 = section(readme, /^#{2,3}\s+Option 1\b/);
  assert.match(opt1, /pending actions? such as the missing Keychain item/i);
  assert.equal(/onboarding has finished, the installer exits/i.test(readme), false);
  assert.equal(/\(exit 3\)/.test(readme), false, 'no unconditional exit 3 claims');
  const row = readme.split('\n').find((l) => l.startsWith('| `--non-interactive`'));
  assert.equal(/\(exit code 3\)/.test(row), false);
});

test('the one-liner section makes no checksum claim, explains the truncation guard, and prefers git clone', () => {
  const opt2 = section(readme, /^#{2,3}\s+Option 2\b/);
  assert.equal(/shasum|checksum|corrupted/i.test(opt2), false, 'no checksum line or corruption claim');
  assert.match(opt2, /runs nothing if the download is cut off/i);
  assert.match(opt2, /one function/i);
  assert.match(opt2, /last line/i);
  assert.match(opt2, /reading the script/i);
  assert.match(opt2, /pinned tag|pinning the tag/i);
  assert.match(opt2, /skips reading it/i);
  assert.equal(/skips both/i.test(opt2), false);
  assert.match(opt2, /prefer `git clone`|prefer the `git clone`/i);
  assert.equal(/two hashes must match/i.test(opt2), false);
});

test('ONBOARDING.md writes no third-party contact data before the gate: Connections.csv is placed only after it, with consent', () => {
  const pre = ['Draft mode', 'Resume from drafts', 'Step 1: State and inventory', 'Step 2: Extract text (the ladder)', 'Step 3: The questionnaire (once, before writing)', 'Step 4: Map answers to files']
    .map((t) => section(onboarding, new RegExp(`^#{2,3}\\s+${t.replace(/[()]/g, '\\$&')}$`))).join('\n');
  assert.equal(/data\/Connections\.csv/.test(pre), false, 'no write of data/Connections.csv before the gate');
  assert.match(pre, /Never read `Connections\.csv` into the profile/);
  const after = section(onboarding, /^#{2,3}\s+Step 7: Offers$/);
  assert.match(after, /data\/Connections\.csv/);
  assert.match(after, /linkedin-join\.mjs/);
  assert.match(after, /consent/i);
  assert.equal(/ask(s)? for it/i.test(after), false, 'Step 7 must offer it, as Step 2 says, not wait to be asked');
  assert.match(section(onboarding, /^#{2,3}\s+Step 2: Extract text \(the ladder\)$/), /Step 7 offers/);
  assert.match(after, /offer/i);
});

test('decline cleanup only touches staging created in this session and keeps pre-existing drafts unless separately chosen', () => {
  const rule5 = onboarding.split('\n').find((l) => /^5\. /.test(l));
  const gate = section(onboarding, /^#{2,3}\s+Step 5: The gate$/);
  for (const [name, text] of [['rule 5', rule5], ['the gate', gate]]) {
    assert.match(text, /this session/i, `${name}: scoped to this session`);
    assert.match(text, /pre-?existing/i, `${name}: pre-existing drafts`);
    assert.match(text, /own explicit question/i, `${name}: separate explicit choice`);
  }
  assert.equal(/delete[^.]*staged copies, extracted files, temp conversions and `data\/install\/onboarding-draft\/`/i.test(onboarding), false, 'no blanket delete of the whole draft dir');
});

test('the gate lists every pre-existing file, each draft file and whether it was created this session, before asking for cleanup consent', () => {
  const gate = section(onboarding, /^#{2,3}\s+Step 5: The gate$/);
  const inventory = gate.slice(gate.search(/staging inventory/i));
  assert.match(inventory, /individually/i);
  assert.match(inventory, /data\/install\/onboarding-draft\//);
  assert.match(inventory, /pre-?existing/i);
  assert.match(inventory, /pre-?existing, updated this session/i);
  assert.match(inventory, /created this session/i);
  assert.ok(gate.search(/staging inventory/i) < gate.search(/Write these files\?/), 'inventory comes before the question');
  assert.ok(gate.search(/created this session/i) < gate.search(/offer to delete/i), 'inventory comes before the cleanup offer');
});

test('ONBOARDING.md records the pre-existing set before Step 1, and pre-existing always wins over "updated this session"', () => {
  const titles = headings(onboarding).map((h) => h.text);
  const pre = titles.findIndex((t) => /^Before Step 1: record the pre-existing set$/.test(t));
  assert.ok(pre !== -1, titles.join(' | '));
  assert.ok(pre < titles.indexOf('Step 1: State and inventory'));
  const rec = section(onboarding, /^#{2,3}\s+Before Step 1: record the pre-existing set$/);
  for (const dir of ['documents/', 'data/install/tmp/', 'data/install/onboarding-draft/']) assert.ok(rec.includes(dir), `records ${dir}`);
  assert.match(rec, /before (you )?(run|do|touch|create|copy|write)/i);
  assert.match(rec, /pre-existing set/);

  const rule5 = onboarding.split('\n').find((l) => /^5\. /.test(l));
  const gate = section(onboarding, /^#{2,3}\s+Step 5: The gate$/);
  for (const [name, text] of [['rule 5', rule5], ['the gate', gate]]) {
    assert.match(text, /pre-existing set/i, `${name}: names the set`);
    assert.match(text, /even if[^.]*updated[^.]*this session/i, `${name}: pre-existing wins over updated`);
    assert.match(text, /never[^.]*(removed|deleted)|(removed|deleted)[^.]*never/i, `${name}: never removed by the decline cleanup`);
    assert.match(text, /not in the pre-existing set/i, `${name}: only files created this session are deleted`);
    assert.match(text, /own explicit question/i, `${name}: deleting a pre-existing file needs its own question`);
    assert.match(text, /per file or (per )?group/i, `${name}: per file or group`);
  }
});

test('the pre-existing set is snapshotted as absolute paths under the effective data root, and installer-copied files count as pre-existing', () => {
  const rec = section(onboarding, /^#{2,3}\s+Before Step 1: record the pre-existing set$/);
  assert.match(rec, /effective data root/i);
  assert.ok(rec.includes("import('./path-resolver.mjs').then((m) => console.log(m.getCareerOpsRoot()))") && onboarding.indexOf("import('./path-resolver.mjs').then((m) => console.log(m.getCareerOpsRoot()))") < onboarding.indexOf('## Before Step 1'), 'uses the same path-resolver one-liner as the rest of the doc');
  assert.match(rec, /absolute paths/i);
  assert.match(rec, /resolve[^.]*data root[^.]*first|first[^.]*resolve[^.]*data root/i);
  assert.match(rec, /--resume/);
  assert.match(rec, /--docs/);
  assert.match(rec, /before this session[^.]*pre-existing|pre-existing[^.]*before this session/i);
  assert.match(rec, /kept on decline/i);
  assert.match(rec, /delete them (by hand|manually)/i);
});

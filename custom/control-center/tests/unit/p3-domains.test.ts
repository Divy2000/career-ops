import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { applyYamlOps, parseYamlDoc, YamlOpsError } from '../../server/domains/yamlOps.js';
import { parseBlacklist, renderBlacklist, DEFAULT_BLACKLIST_PREAMBLE } from '../../server/domains/blacklist.js';
import { computeNextFire, parseLaunchctlPrint, parsePrintDisabled, pinnedNodeBin, renderPlist, SCHEDULE_JOBS } from '../../server/system/schedule.js';
import { computeUsage } from '../../server/domains/usage.js';
import { appSettingsSchema, DEFAULT_SETTINGS, mergeSettings } from '../../server/domains/settings.js';
import { tempDir } from '../helpers/tmp.js';

const PORTALS = `# Synthetic portals config for tests
title_filter:
  positive:
    - backend # keep this comment
  negative:
    - intern

location_filter:
  strict: false
  allow:
    - Remote

tracked_companies:
  - name: Acme Robotics
    careers_url: https://jobs.example.com/acme
    provider: greenhouse
    enabled: true

custom_unknown_key: # a key the editor does not know about
  nested: value

max_posting_age_days: 30
`;

describe('applyYamlOps (yaml Document API)', () => {
  it('set, insert and delete keep comments and unknown keys intact', () => {
    const out = applyYamlOps(PORTALS, [
      { op: 'set', path: ['tracked_companies', 0, 'enabled'], value: false },
      { op: 'insert', path: ['tracked_companies'], value: { name: 'Umbrella Corp', careers_url: 'https://jobs.lever.co/umbrella', provider: 'lever', enabled: true } },
      { op: 'set', path: ['location_filter', 'strict'], value: true },
      { op: 'insert', path: ['title_filter', 'positive'], index: 0, value: 'platform' },
      { op: 'set', path: ['max_posting_age_days'], value: 14 },
      { op: 'delete', path: ['title_filter', 'negative'] },
    ]);
    expect(out.startsWith('# Synthetic portals config for tests')).toBe(true);
    expect(out).toContain('- backend # keep this comment');
    expect(out).toContain('custom_unknown_key:');
    expect(out).toContain('# a key the editor does not know about');
    expect(out).toContain('  nested: value');
    expect(out).toContain('enabled: false');
    expect(out).toContain('name: Umbrella Corp');
    expect(out).toContain('strict: true');
    expect(out).toContain('max_posting_age_days: 14');
    expect(out).not.toContain('negative');
    expect(out.indexOf('- platform')).toBeLessThan(out.indexOf('- backend'));
  });

  it('a no-op round trip returns the same text', () => {
    expect(applyYamlOps(PORTALS, [])).toBe(PORTALS);
  });

  it('creates the structure when the file is empty and when the list is missing', () => {
    const out = applyYamlOps('', [
      { op: 'set', path: ['followup_cadence', 'applied_first_days'], value: 10 },
      { op: 'insert', path: ['search_queries'], value: 'staff engineer' },
    ]);
    expect(out).toContain('followup_cadence:\n  applied_first_days: 10');
    expect(out).toContain('search_queries:\n  - staff engineer');
  });

  it('a delete under a missing map, or in an empty file, changes nothing instead of throwing (SW5-server-03)', () => {
    const profile = 'candidate:\n  full_name: Alex\n# followup_cadence:\n#   applied_first_days: 7\n';
    expect(applyYamlOps(profile, [{ op: 'delete', path: ['followup_cadence', 'applied_first_days'] }])).toBe(profile);
    expect(applyYamlOps('', [{ op: 'delete', path: ['followup_cadence', 'applied_first_days'] }])).toBe('');
    // A cleared field and a set in one save: the set lands, the delete is a no-op.
    const out = applyYamlOps(profile, [
      { op: 'delete', path: ['followup_cadence', 'applied_first_days'] },
      { op: 'set', path: ['followup_cadence', 'applied_subsequent_days'], value: 5 },
    ]);
    expect(parseYamlDoc(out).doc).toEqual({ candidate: { full_name: 'Alex' }, followup_cadence: { applied_subsequent_days: 5 } });
  });

  it('a set or insert under a key whose value is empty (only commented children) fills it in (SW5-server-03)', () => {
    const empty = 'followup_cadence:\n  # applied_first_days: 7\nsearch:\n';
    const out = applyYamlOps(empty, [
      { op: 'set', path: ['followup_cadence', 'applied_first_days'], value: 9 },
      { op: 'insert', path: ['search', 'queries'], value: 'staff engineer' },
    ]);
    expect(parseYamlDoc(out).doc).toEqual({ followup_cadence: { applied_first_days: 9 }, search: { queries: ['staff engineer'] } });
    expect(applyYamlOps(empty, [{ op: 'delete', path: ['followup_cadence', 'applied_first_days'] }])).toBe(empty);
  });

  it('a set through a value that is not a map or list is refused as a bad op, not a crash; a delete there has nothing to delete (SW5-server-03)', () => {
    let err: unknown;
    try {
      applyYamlOps('followup_cadence: 3\n', [{ op: 'set', path: ['followup_cadence', 'applied_first_days'], value: 9 }]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(YamlOpsError);
    expect((err as YamlOpsError).code).toBe('bad-op');
    expect((err as YamlOpsError).message).toMatch(/followup_cadence\.applied_first_days/);
    expect(applyYamlOps('followup_cadence: 3\n', [{ op: 'delete', path: ['followup_cadence', 'x', 'y'] }])).toBe('followup_cadence: 3\n');
  });

  describe('a comment at an outer indent after a nested block that ends in its own comment stays at that indent', () => {
    const comments = (raw: string) => raw.split('\n').filter((l) => l.trim().startsWith('#'));

    it('keeps a commented-out top-level block at column 0, before the next key, so uncommenting it still makes a top-level key', () => {
      const raw = 'location:\n  city: Austin\n  # onsite: yes\n\n# Optional cadence.\n# followup_cadence:\n#   applied_first_days: 7\n\nspend_tier: standard\n';
      const out = applyYamlOps(raw, [{ op: 'set', path: ['location', 'city'], value: 'Boston' }]);
      expect(out).toBe(raw.replace('Austin', 'Boston'));
      const uncommented = out.replace('# followup_cadence:\n#   applied_first_days: 7', 'followup_cadence:\n  applied_first_days: 7');
      expect(parseYamlDoc(uncommented).doc).toEqual({ location: { city: 'Boston' }, followup_cadence: { applied_first_days: 7 }, spend_tier: 'standard' });
    });

    it('keeps the comments that end the file at column 0', () => {
      const raw = 'a: 1\nb:\n  c: 2\n  # inner\n\n# outer tail\n# d: 3\n';
      expect(applyYamlOps(raw, [{ op: 'set', path: ['a'], value: 5 }])).toBe(raw.replace('a: 1', 'a: 5'));
    });

    it('keeps a comment after a list that ends in its own comment at the outer indent', () => {
      const raw = 'roles:\n  - Staff\n  # - Principal\n\n# next section\ntier: standard\n';
      expect(applyYamlOps(raw, [{ op: 'set', path: ['tier'], value: 'premium' }])).toBe(raw.replace('tier: standard', 'tier: premium'));
    });

    it('keeps a comment at an intermediate indent with the block it was written in', () => {
      const raw = 'a:\n  b:\n    c: 1\n    # deep\n  # middle\n  d: 2\ne: 3\n';
      expect(applyYamlOps(raw, [{ op: 'set', path: ['e'], value: 4 }])).toBe(raw.replace('e: 3', 'e: 4'));
      const tail = 'a:\n  b:\n    c: 1\n    # deep\n  # middle\ne: 3\n';
      expect(applyYamlOps(tail, [{ op: 'set', path: ['e'], value: 4 }])).toBe(tail.replace('e: 3', 'e: 4'));
    });

    it('keeps every comment line of config/profile.example.yml, indent included, through a field edit and a cadence write', () => {
      const example = fs.readFileSync(path.resolve(import.meta.dirname, '../../../../config/profile.example.yml'), 'utf8');
      const out = applyYamlOps(example, [
        { op: 'set', path: ['candidate', 'full_name'], value: 'Jane Q. Smith' },
        { op: 'set', path: ['followup_cadence', 'applied_first_days'], value: 9 },
      ]);
      expect(comments(out)).toEqual(comments(example));
      expect(parseYamlDoc(out).doc).toMatchObject({ candidate: { full_name: 'Jane Q. Smith' }, language: { output: 'en' }, followup_cadence: { applied_first_days: 9 } });
    });
  });

  it('refuses malformed YAML and inserts into something that is not a list', () => {
    expect(() => applyYamlOps('a: [unclosed', [{ op: 'set', path: ['a'], value: 1 }])).toThrow(YamlOpsError);
    expect(() => applyYamlOps('a: 1\n', [{ op: 'insert', path: ['a'], value: 2 }])).toThrow(/not a list/);
  });
});

describe('blacklist parse and render (templates/blacklist.example.md format)', () => {
  const TEMPLATE_STYLE = `# Blacklist

Some intro text about the file.

| Company | Since | Scope | Reason |
|---------|-------|-------|--------|
| Acme Corp | 2026-01-15 | company | example: post-interview process signals |
| ibm.com | 2026-03-01 | domain | example: avoid postings on IBM-owned ATS hosts |
`;
  it('parses the four-column template format', () => {
    const parsed = parseBlacklist(TEMPLATE_STYLE);
    expect(parsed.rows).toEqual([
      { company: 'Acme Corp', since: '2026-01-15', scope: 'company', reason: 'example: post-interview process signals' },
      { company: 'ibm.com', since: '2026-03-01', scope: 'domain', reason: 'example: avoid postings on IBM-owned ATS hosts' },
    ]);
    expect(parsed.preamble).toContain('Some intro text about the file.');
  });
  it('reads a table whose company column is headed "Company name", so a save keeps its rows', () => {
    const md = '# Blacklist\n\n| Company name | Reason |\n|---|---|\n| Spam Staffing Ltd | body-shop |\n| Acme Recruiting | spam |\n';
    const parsed = parseBlacklist(md);
    expect(parsed.rows.map((r) => r.company)).toEqual(['Spam Staffing Ltd', 'Acme Recruiting']);
    expect(parsed.extraColumns).toEqual([]);
    const saved = renderBlacklist(parsed.rows, parsed.preamble, parsed.postamble, parsed.extraColumns);
    expect(parseBlacklist(saved).rows).toEqual(parsed.rows);
  });

  it('maps the legacy three-column table (Company, Reason, Added) to company scope', () => {
    const parsed = parseBlacklist('# Blacklist\n\n| Company | Reason | Added |\n|---|---|---|\n| Spam Staffing Ltd | body-shop | 2026-09-01 |\n');
    expect(parsed.rows).toEqual([{ company: 'Spam Staffing Ltd', since: '2026-09-01', scope: 'company', reason: 'body-shop' }]);
  });
  it('keeps everything after the table verbatim and never merges a second table into the rows', () => {
    const table = '| Company | Since | Scope | Reason |\n|---------|-------|-------|--------|\n| Acme Corp | 2026-01-15 | company | x |\n';
    const tail = '\n## Notes\n\nKeep this paragraph.\n\n| Other | Table |\n|---|---|\n| a | b |\n';
    const md = `# Blacklist\n\nIntro.\n\n${table}${tail}`;
    const parsed = parseBlacklist(md);
    expect(parsed.rows).toEqual([{ company: 'Acme Corp', since: '2026-01-15', scope: 'company', reason: 'x' }]);
    expect(parsed.postamble).toBe(tail);
    expect(renderBlacklist(parsed.rows, parsed.preamble, parsed.postamble)).toBe(md);
    const added = renderBlacklist([...parsed.rows, { company: 'Initech', since: '2026-10-03', scope: 'company', reason: 'y' }], parsed.preamble, parsed.postamble);
    expect(added).toBe(`# Blacklist\n\nIntro.\n\n${table}| Initech | 2026-10-03 | company | y |\n${tail}`);
  });

  it('carries columns it does not manage through every row, in order, and leaves them empty on new rows', () => {
    const md = '# Blacklist\n\n| Company | Reason | Added | Contact | Ticket |\n|---|---|---|---|---|\n| Old Corp | reposts | 2025-09-01 | jane@old.example | T-1 |\n| Short Row | spam | 2025-10-01 |\n';
    const parsed = parseBlacklist(md);
    expect(parsed.extraColumns).toEqual(['Contact', 'Ticket']);
    expect(parsed.rows).toEqual([
      { company: 'Old Corp', since: '2025-09-01', scope: 'company', reason: 'reposts', extra: ['jane@old.example', 'T-1'] },
      { company: 'Short Row', since: '2025-10-01', scope: 'company', reason: 'spam', extra: ['', ''] },
    ]);
    const rendered = renderBlacklist([...parsed.rows, { company: 'Initech', since: '2026-10-03', scope: 'company', reason: 'y' }], parsed.preamble, parsed.postamble, parsed.extraColumns);
    expect(rendered).toContain('| Company | Since | Scope | Reason | Contact | Ticket |\n|---------|-------|-------|--------|---|---|\n');
    expect(rendered).toContain('| Old Corp | 2025-09-01 | company | reposts | jane@old.example | T-1 |\n');
    expect(rendered).toContain('| Initech | 2026-10-03 | company | y |  |  |\n');
    expect(parseBlacklist(rendered).extraColumns).toEqual(['Contact', 'Ticket']);
    expect(renderBlacklist(parsed.rows, parsed.preamble, parsed.postamble, [])).not.toContain('Contact');
  });

  it('renders the template format and round-trips its own output', () => {
    const parsed = parseBlacklist(TEMPLATE_STYLE);
    const rendered = renderBlacklist(parsed.rows, parsed.preamble);
    expect(rendered).toContain('| Company | Since | Scope | Reason |');
    expect(parseBlacklist(rendered)).toEqual(parsed);
    expect(renderBlacklist([], null)).toContain(DEFAULT_BLACKLIST_PREAMBLE.trim());
  });
});

describe('launchd schedule helpers', () => {
  it('writes the job logs under the data root (where the log browser reads them) and runs the script from the code root', () => {
    const xml = renderPlist('/code', SCHEDULE_JOBS[0]!, { hour: 8, minute: 0, weekday: null }, '/data');
    expect(xml).toContain('<string>/bin/bash</string><string>/code/custom/immigration/run-daily.sh</string>');
    expect(xml).toContain('<key>WorkingDirectory</key><string>/code</string>');
    expect(xml).toContain('<key>StandardOutPath</key><string>/data/data/immigration/logs/launchd.out.log</string>');
    expect(xml).toContain('<key>StandardErrorPath</key><string>/data/data/immigration/logs/launchd.err.log</string>');
    expect(xml).not.toContain('/code/data/');
  });
  it('passes the data root to the job as CAREER_OPS_ROOT, so it works on the same root as the app (escaped as XML)', () => {
    const xml = renderPlist('/code', SCHEDULE_JOBS[0]!, { hour: 8, minute: 0, weekday: null }, '/data');
    expect(xml).toContain('<key>EnvironmentVariables</key><dict><key>CAREER_OPS_ROOT</key><string>/data</string></dict>');
    expect(renderPlist('/code', SCHEDULE_JOBS[1]!, { hour: 3, minute: 0, weekday: 0 }, '/Users/me/R&D <data>')).toContain('<key>CAREER_OPS_ROOT</key><string>/Users/me/R&amp;D &lt;data&gt;</string>');
  });
  it('leaves CAREER_OPS_ROOT out when the root did not come from the environment, so the job resolves a marker at run time', () => {
    const xml = renderPlist('/code', SCHEDULE_JOBS[0]!, { hour: 8, minute: 0, weekday: null }, '/data', { pinDataRoot: false });
    expect(xml).not.toContain('EnvironmentVariables');
    expect(xml).not.toContain('CAREER_OPS_ROOT');
    expect(xml).toContain('<key>StandardOutPath</key><string>/data/data/immigration/logs/launchd.out.log</string>');
    const pinned = renderPlist('/code', SCHEDULE_JOBS[0]!, { hour: 8, minute: 0, weekday: null }, '/data', { pinDataRoot: true });
    expect(pinned).toContain('<key>CAREER_OPS_ROOT</key><string>/data</string>');
  });
  it('pins the daily job to the absolute claude the app resolved (CC_CLAUDE_BIN), escaped, and never the weekly job or a bare name', () => {
    const daily = renderPlist('/code', SCHEDULE_JOBS[0]!, { hour: 8, minute: 0, weekday: null }, '/data', { claudeBin: '/opt/homebrew/bin/claude' });
    expect(daily).toContain('<key>EnvironmentVariables</key><dict><key>CAREER_OPS_ROOT</key><string>/data</string><key>CC_CLAUDE_BIN</key><string>/opt/homebrew/bin/claude</string></dict>');
    // A root resolved from a marker at run time still gets the pinned binary.
    expect(renderPlist('/code', SCHEDULE_JOBS[0]!, { hour: 8, minute: 0, weekday: null }, '/data', { pinDataRoot: false, claudeBin: '/Users/me/R&D <bin>/claude' })).toContain('<key>EnvironmentVariables</key><dict><key>CC_CLAUDE_BIN</key><string>/Users/me/R&amp;D &lt;bin&gt;/claude</string></dict>');
    expect(renderPlist('/code', SCHEDULE_JOBS[0]!, { hour: 8, minute: 0, weekday: null }, '/data', { claudeBin: 'claude' })).not.toContain('CC_CLAUDE_BIN');
    expect(renderPlist('/code', SCHEDULE_JOBS[1]!, { hour: 3, minute: 0, weekday: 0 }, '/data', { claudeBin: '/opt/homebrew/bin/claude' })).not.toContain('CC_CLAUDE_BIN');
  });
  it('pins both jobs to the absolute node the app runs on (CC_NODE_BIN), escaped and last, and never a bare name (SW-scripts-03)', () => {
    expect(renderPlist('/code', SCHEDULE_JOBS[0]!, { hour: 8, minute: 0, weekday: null }, '/data', { claudeBin: '/b/claude', nodeBin: '/Users/me/.nvm/versions/node/v22.6.0/bin/node' })).toContain(
      '<key>EnvironmentVariables</key><dict><key>CAREER_OPS_ROOT</key><string>/data</string><key>CC_CLAUDE_BIN</key><string>/b/claude</string><key>CC_NODE_BIN</key><string>/Users/me/.nvm/versions/node/v22.6.0/bin/node</string></dict>',
    );
    expect(renderPlist('/code', SCHEDULE_JOBS[1]!, { hour: 3, minute: 0, weekday: 0 }, '/data', { pinDataRoot: false, nodeBin: '/R&D <n>/node' })).toContain('<key>EnvironmentVariables</key><dict><key>CC_NODE_BIN</key><string>/R&amp;D &lt;n&gt;/node</string></dict>');
    expect(renderPlist('/code', SCHEDULE_JOBS[0]!, { hour: 8, minute: 0, weekday: null }, '/data', { nodeBin: 'node' })).not.toContain('CC_NODE_BIN');
  });
  describe('pinnedNodeBin: the node CC_NODE_BIN names', () => {
    // process.execPath is the real binary (/opt/homebrew/Cellar/node/<version>/bin/node), which a Homebrew upgrade
    // removes; the stable name is the link on PATH that leads to it.
    function onPath(dirs: Record<string, string | null>): { pathEnv: string; dir: (k: string) => string } {
      const root = tempDir('cc-node-pin-');
      const dir = (k: string) => path.join(root, k);
      for (const [k, target] of Object.entries(dirs)) {
        fs.mkdirSync(dir(k), { recursive: true });
        if (target) fs.symlinkSync(target, path.join(dir(k), 'node'));
      }
      return { pathEnv: Object.keys(dirs).map(dir).join(path.delimiter), dir };
    }
    const real = fs.realpathSync(process.execPath);

    it('keeps a package manager\'s stable link on PATH (Homebrew\'s /opt/homebrew/bin/node) as given, so an upgrade cannot stale the pin', () => {
      const { pathEnv, dir } = onPath({ 'homebrew/bin': process.execPath });
      expect(pinnedNodeBin(real, pathEnv)).toBe(path.join(dir('homebrew/bin'), 'node'));
    });

    it('resolves a per-shell link (fnm\'s multishell folders, gone after logout) to the real binary', () => {
      const { pathEnv } = onPath({ 'fnm_multishells/1234_5678/bin': process.execPath });
      expect(pinnedNodeBin(real, pathEnv)).toBe(real);
    });

    it('looks only at the first node on PATH, as install.sh\'s `command -v node` does: one that is another binary (a shim) pins the real binary', () => {
      const other = tempDir('cc-node-other-');
      fs.writeFileSync(path.join(other, 'node'), '#!/bin/sh\n', { mode: 0o755 });
      const shimFirst = onPath({ shim: path.join(other, 'node'), 'homebrew/bin': process.execPath });
      expect(pinnedNodeBin(real, shimFirst.pathEnv)).toBe(real);
      // A folder with no node is passed over, like command -v does.
      const gapFirst = onPath({ empty: null, 'homebrew/bin': process.execPath });
      expect(pinnedNodeBin(real, gapFirst.pathEnv)).toBe(path.join(gapFirst.dir('homebrew/bin'), 'node'));
    });

    it('pins the real binary when no node is on PATH, or the first one is reached through a relative entry', () => {
      expect(pinnedNodeBin(real, onPath({ empty: null }).pathEnv)).toBe(real);
      // A relative entry (node_modules/.bin, say) found first, written relative to the current folder.
      const rel = tempDir('cc-node-rel-');
      fs.symlinkSync(process.execPath, path.join(rel, 'node'));
      const relative = path.relative(process.cwd(), rel);
      expect(path.isAbsolute(relative)).toBe(false);
      expect(pinnedNodeBin(real, `${relative}${path.delimiter}${onPath({ 'homebrew/bin': process.execPath }).pathEnv}`)).toBe(real);
    });
  });
  it('reads the persistent disabled state from launchctl print-disabled (both output styles)', () => {
    const out = 'disabled services = {\n\t"com.apple.Siri.agent" => enabled\n\t"com.career-ops.immigration-watch" => disabled\n\t"com.career-ops.upstream-sync" => false\n\t"com.old.style" => true\n}\n';
    expect(parsePrintDisabled(out, 'com.career-ops.immigration-watch')).toBe(true);
    expect(parsePrintDisabled(out, 'com.career-ops.upstream-sync')).toBe(false);
    expect(parsePrintDisabled(out, 'com.old.style')).toBe(true);
    expect(parsePrintDisabled(out, 'com.apple.Siri.agent')).toBe(false);
    expect(parsePrintDisabled(out, 'com.not.listed')).toBe(false);
    expect(parsePrintDisabled(out, 'com.career-ops.immigration')).toBe(false);
  });
  it('renders a plist that keeps ProgramArguments on the fork script and lints as XML', () => {
    const job = SCHEDULE_JOBS.find((j) => j.label === 'com.career-ops.upstream-sync')!;
    const xml = renderPlist('/repo', job, { hour: 3, minute: 15, weekday: 0 }, '/repo');
    expect(xml).toContain('<string>/bin/bash</string><string>/repo/custom/upstream-sync/sync.sh</string>');
    expect(xml).toContain('<key>Hour</key><integer>3</integer><key>Minute</key><integer>15</integer><key>Weekday</key><integer>0</integer>');
    expect(xml).toContain('<key>Label</key><string>com.career-ops.upstream-sync</string>');
    const daily = renderPlist('/repo', SCHEDULE_JOBS[0]!, { hour: 8, minute: 0, weekday: null }, '/repo');
    expect(daily).not.toContain('Weekday');
    expect(daily).toContain('custom/immigration/run-daily.sh');
  });
  it('computes the next fire for daily and weekly jobs', () => {
    const now = new Date(2026, 9, 3, 9, 30); // Saturday 2026-10-03 09:30 local
    expect(computeNextFire(now, 8, 0, null).getDate()).toBe(4);
    expect(computeNextFire(now, 10, 0, null).getDate()).toBe(3);
    const weekly = computeNextFire(now, 3, 0, 0);
    expect(weekly.getDay()).toBe(0);
    expect(weekly.getDate()).toBe(4);
    const sameDayLater = computeNextFire(now, 23, 0, 6);
    expect(sameDayLater.getDate()).toBe(3);
  });
  it('parses launchctl print output', () => {
    expect(parseLaunchctlPrint('gui/501/com.x = {\n\tstate = waiting\n\tlast exit code = 0\n}')).toEqual({ state: 'waiting', lastExit: 0, lastSignal: null, runs: null });
    expect(parseLaunchctlPrint('\tstate = running\n\tlast exit code = (never exited)\n')).toEqual({ state: 'running', lastExit: null, lastSignal: null, runs: null });
  });
});

describe('usage meter from ~/.claude/projects jsonl', () => {
  it('sums input, output and cache-creation tokens over 5h and 7d, dedups by requestId and ignores older lines', () => {
    const dir = tempDir('cc-usage-unit-');
    fs.mkdirSync(path.join(dir, 'proj-a'));
    const now = Date.parse('2026-10-03T12:00:00Z');
    const line = (ts: number, input: number, output: number, cache: number, requestId: string) =>
      JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), requestId, message: { usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cache, cache_read_input_tokens: 5000 } } });
    fs.writeFileSync(
      path.join(dir, 'proj-a', 'session.jsonl'),
      [
        line(now - 3_600_000, 100, 50, 10, 'r1'),
        line(now - 3_600_000, 100, 50, 10, 'r1'),
        '{"type":"user","timestamp":"2026-10-03T11:00:00Z"}',
        'not json at all',
        line(now - 3 * 86_400_000, 1000, 200, 0, 'r2'),
        line(now - 10 * 86_400_000, 9999, 9999, 9999, 'r3'),
      ].join('\n'),
    );
    const usage = computeUsage(dir, now);
    expect(usage.kind).toBe('ok');
    expect(usage.fiveHour).toMatchObject({ tokens: 160, input: 100, output: 50, cacheCreation: 10, messages: 1 });
    expect(usage.sevenDay).toMatchObject({ tokens: 1360, messages: 2 });
    expect(computeUsage(path.join(dir, 'nope'), now).kind).toBe('missing');
  });
});

describe('usage meter reads only what the transcripts gained (SW5-server-04)', () => {
  afterEach(() => vi.restoreAllMocks());
  const line = (ts: number, input: number, requestId: string) => JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), requestId, message: { usage: { input_tokens: input, output_tokens: 0, cache_creation_input_tokens: 0 } } });
  /** Bytes the next call reads from transcript files, however it reads them. */
  function bytesRead(fn: () => void): number {
    let n = 0;
    const whole = vi.spyOn(fs, 'readFileSync');
    const part = vi.spyOn(fs, 'readSync');
    try {
      fn();
      for (const r of whole.mock.results) if (r.type === 'return') n += Buffer.byteLength(r.value as string | Buffer);
      for (const r of part.mock.results) if (r.type === 'return') n += r.value as number;
    } finally {
      whole.mockRestore();
      part.mockRestore();
    }
    return n;
  }

  it('a refresh with nothing new reads no transcript bytes, and an append reads only the appended bytes', () => {
    const dir = tempDir('cc-usage-incr-');
    fs.mkdirSync(path.join(dir, 'proj'));
    const file = path.join(dir, 'proj', 's.jsonl');
    const now = Date.parse('2026-10-03T12:00:00Z');
    fs.writeFileSync(file, `${line(now - 60_000, 100, 'a')}\n${'{"type":"user","text":"' + 'x'.repeat(50_000) + '"}'}\n`);
    expect(computeUsage(dir, now).fiveHour.tokens).toBe(100);
    let again!: ReturnType<typeof computeUsage>;
    expect(bytesRead(() => (again = computeUsage(dir, now + 1000)))).toBe(0);
    expect(again.fiveHour.tokens).toBe(100);
    const added = `${line(now - 30_000, 7, 'b')}\n`;
    fs.appendFileSync(file, added);
    let after!: ReturnType<typeof computeUsage>;
    expect(bytesRead(() => (after = computeUsage(dir, now + 2000)))).toBe(Buffer.byteLength(added));
    expect(after.fiveHour).toMatchObject({ tokens: 107, messages: 2 });
  });

  it('a line still being written is counted once it is whole, and a rewritten (shorter) file is read again from the start', () => {
    const dir = tempDir('cc-usage-partial-');
    const file = path.join(dir, 's.jsonl');
    const now = Date.parse('2026-10-03T12:00:00Z');
    const whole = line(now - 60_000, 40, 'p');
    fs.writeFileSync(file, whole.slice(0, 30));
    expect(computeUsage(dir, now).fiveHour.tokens).toBe(0);
    fs.appendFileSync(file, `${whole.slice(30)}\n`);
    expect(computeUsage(dir, now + 1000).fiveHour).toMatchObject({ tokens: 40, messages: 1 });
    fs.writeFileSync(file, `${line(now - 10_000, 3, 'q')}\n`);
    expect(computeUsage(dir, now + 2000).fiveHour).toMatchObject({ tokens: 3, messages: 1 });
    // Time passing ages lines out of the windows without a read.
    expect(computeUsage(dir, now + 6 * 3_600_000).fiveHour.tokens).toBe(0);
  });
});

describe('app settings', () => {
  it('fills defaults, merges a partial patch and rejects out-of-range values', () => {
    expect(mergeSettings({}, {})).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(DEFAULT_SETTINGS, { claudeConcurrency: 3, logos: true })).toMatchObject({ claudeConcurrency: 3, logos: true, retention: 500 });
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, claudeConcurrency: 9 }).success).toBe(false);
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, retention: 10 }).success).toBe(false);
  });
});

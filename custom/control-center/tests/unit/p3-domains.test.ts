import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { applyYamlOps, YamlOpsError } from '../../server/domains/yamlOps.js';
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

    it('skips a node on PATH that is another binary, and takes the first one that leads to this node', () => {
      const other = tempDir('cc-node-other-');
      fs.writeFileSync(path.join(other, 'node'), '#!/bin/sh\n', { mode: 0o755 });
      const { pathEnv, dir } = onPath({ older: path.join(other, 'node'), 'homebrew/bin': process.execPath, later: process.execPath });
      expect(pinnedNodeBin(real, pathEnv)).toBe(path.join(dir('homebrew/bin'), 'node'));
    });

    it('falls back to the binary itself when no node on PATH leads to it, and skips relative PATH entries', () => {
      expect(pinnedNodeBin(real, `node_modules/.bin${path.delimiter}`)).toBe(real);
      expect(pinnedNodeBin(real, onPath({ empty: null }).pathEnv)).toBe(real);
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

describe('app settings', () => {
  it('fills defaults, merges a partial patch and rejects out-of-range values', () => {
    expect(mergeSettings({}, {})).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(DEFAULT_SETTINGS, { claudeConcurrency: 3, logos: true })).toMatchObject({ claudeConcurrency: 3, logos: true, retention: 500 });
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, claudeConcurrency: 9 }).success).toBe(false);
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, retention: 10 }).success).toBe(false);
  });
});

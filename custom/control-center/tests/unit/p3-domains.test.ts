import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyYamlOps, YamlOpsError } from '../../server/domains/yamlOps.js';
import { parseBlacklist, renderBlacklist, DEFAULT_BLACKLIST_PREAMBLE } from '../../server/domains/blacklist.js';
import { computeNextFire, parseLaunchctlPrint, parsePrintDisabled, renderPlist, SCHEDULE_JOBS } from '../../server/system/schedule.js';
import { computeUsage } from '../../server/domains/usage.js';
import { appSettingsSchema, DEFAULT_SETTINGS, mergeSettings } from '../../server/domains/settings.js';

const PORTALS = `# Synthetic portals config for tests
title_filter:
  include:
    - backend # keep this comment
  exclude:
    - intern

location_filter:
  strict: false
  allow:
    - Remote

tracked_companies:
  - name: Acme Robotics
    ats: greenhouse
    slug: acme-robotics
    enabled: true

custom_unknown_key: # a key the editor does not know about
  nested: value

max_posting_age_days: 30
`;

describe('applyYamlOps (yaml Document API)', () => {
  it('set, insert and delete keep comments and unknown keys intact', () => {
    const out = applyYamlOps(PORTALS, [
      { op: 'set', path: ['tracked_companies', 0, 'enabled'], value: false },
      { op: 'insert', path: ['tracked_companies'], value: { name: 'Umbrella Corp', ats: 'lever', slug: 'umbrella', enabled: true } },
      { op: 'set', path: ['location_filter', 'strict'], value: true },
      { op: 'insert', path: ['title_filter', 'include'], index: 0, value: 'platform' },
      { op: 'set', path: ['max_posting_age_days'], value: 14 },
      { op: 'delete', path: ['title_filter', 'exclude'] },
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
    expect(out).not.toContain('exclude');
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-unit-'));
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

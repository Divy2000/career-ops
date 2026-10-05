// The structured Portals editor writes portals.yml for the upstream scanners, so what it seeds, hints and requires
// must be the schema they read: the shipped template, validate-portals.mjs and buildTitleFilter.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { PORTAL_RULES, PORTAL_SECTIONS } from '@web/features/settings/PortalsEditor';
import { tempDir } from '../helpers/tmp';

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const template = YAML.parse(fs.readFileSync(path.join(CODE_ROOT, 'templates', 'portals.example.yml'), 'utf8')) as { title_filter: Record<string, unknown>; tracked_companies: Array<Record<string, unknown>> };
const section = (key: string) => PORTAL_SECTIONS.find((s) => s.key === key)!;

describe('Portals editor against the scanner schema', () => {
  it('Add title_filter seeds the positive and negative lists the template and buildTitleFilter use', () => {
    const seed = section('title_filter').empty as Record<string, string[]>;
    expect(Object.keys(seed).sort()).toEqual(['negative', 'positive']);
    for (const key of Object.keys(seed)) expect(Object.keys(template.title_filter)).toContain(key);
    // The seed's lists, filled the way a user would; the scanner's own buildTitleFilter judges three titles.
    const filled = Object.fromEntries(Object.keys(seed).map((k) => [k, k === 'positive' ? ['backend'] : ['intern']]));
    const script = `import { buildTitleFilter } from ${JSON.stringify(path.join(CODE_ROOT, 'title-keywords.mjs'))};
const keep = buildTitleFilter(${JSON.stringify(filled)});
process.stdout.write(JSON.stringify(['Backend Engineer', 'Backend Intern', 'Sales'].map(keep)));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(JSON.parse(run.stdout)).toEqual([true, false, false]);
  });

  it('tracked_companies hints the columns the template entries carry, careers_url included', () => {
    const used = new Set(template.tracked_companies.flatMap((c) => Object.keys(c)));
    const columns = section('tracked_companies').columns!;
    expect(columns).toContain('careers_url');
    for (const c of columns) expect([...used], c).toContain(c);
  });

  it('the row rules accept every template company and a new one with just a name and a careers URL', () => {
    const rules = Object.entries(PORTAL_RULES).filter(([k]) => k.startsWith('tracked_companies.*.'));
    const rows = [...template.tracked_companies, { name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme' }];
    for (const row of rows) {
      for (const [key, rule] of rules) {
        const col = key.split('.').at(-1)!;
        expect(rule(row[col] === undefined ? '' : String(row[col])), `${key} on ${String(row.name)}`).toBeNull();
      }
    }
  });

  it('what the editor seeds plus a name-and-URL company passes validate-portals.mjs', () => {
    const config = Object.fromEntries(PORTAL_SECTIONS.map((s) => [s.key, s.empty]));
    config.tracked_companies = [{ name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme', enabled: true }];
    const file = path.join(tempDir('portals-schema-'), 'portals.yml');
    fs.writeFileSync(file, YAML.stringify(config));
    const run = spawnSync(process.execPath, [path.join(CODE_ROOT, 'validate-portals.mjs'), '--file', file], { encoding: 'utf8' });
    expect(run.stdout + run.stderr).toContain('0 errors');
    expect(run.status).toBe(0);
  });
});

// Settings > Portals > Structured on a list with no entries yet (a new section, or every row removed): the editor
// must still offer the section's columns, and the row it inserts must be an entry the scanners accept (R7-06).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import type { YamlOp } from '@shared/api';
import { KeyEditor } from '@web/features/settings/StructuredEditor';
import { PORTAL_RULES, PORTAL_SECTIONS } from '@web/features/settings/PortalsEditor';
import { tempDir } from '../helpers/tmp';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const template = YAML.parse(fs.readFileSync(path.join(CODE_ROOT, 'templates', 'portals.example.yml'), 'utf8')) as Record<string, unknown>;
const LIST_SECTIONS = PORTAL_SECTIONS.filter((s) => Array.isArray(s.empty));

let host: HTMLElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

async function mountEmpty(key: string): Promise<YamlOp[]> {
  const sec = PORTAL_SECTIONS.find((s) => s.key === key)!;
  const ops: YamlOp[] = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(KeyEditor, { path: [key], value: [], onOp: (op: YamlOp) => ops.push(op), rules: PORTAL_RULES, columnsHint: sec.columns })));
  return ops;
}

async function fill(label: string, value: string) {
  const input = host!.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(input, label).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const addRow = async () => act(async () => [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Add row')!.click());

function validate(config: Record<string, unknown>) {
  const file = path.join(tempDir('portals-empty-list-'), 'portals.yml');
  fs.writeFileSync(file, YAML.stringify(config));
  return spawnSync(process.execPath, [path.join(CODE_ROOT, 'validate-portals.mjs'), '--file', file], { encoding: 'utf8' });
}

describe('an empty Portals list in the structured editor', () => {
  it('every list section names the columns of the entries its scanner reads', () => {
    for (const sec of LIST_SECTIONS) expect(sec.columns?.length, sec.key).toBeGreaterThan(0);
    for (const key of ['tracked_companies', 'job_boards', 'search_queries']) {
      const used = new Set((template[key] as Array<Record<string, unknown>>).flatMap((e) => Object.keys(e)));
      for (const c of PORTAL_SECTIONS.find((s) => s.key === key)!.columns!) expect([...used], `${key}.${c}`).toContain(c);
    }
    // scan-interamt.mjs reads each search's `was` keyword.
    expect(fs.readFileSync(path.join(CODE_ROOT, 'scan-interamt.mjs'), 'utf8')).toContain('interamtSearches.map(s => s.was)');
    expect(PORTAL_SECTIONS.find((s) => s.key === 'interamt_searches')!.columns).toEqual(['was']);
  });

  for (const [key, cells, expected] of [
    ['tracked_companies', { name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme', enabled: 'true' }, { name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme', enabled: true }],
    ['job_boards', { name: 'Board', careers_url: 'https://solid.jobs/public-api/offers/it', enabled: 'false' }, { name: 'Board', careers_url: 'https://solid.jobs/public-api/offers/it', enabled: false }],
    ['search_queries', { name: 'Backend', query: 'site:jobs.lever.co backend' }, { name: 'Backend', query: 'site:jobs.lever.co backend' }],
    ['interamt_searches', { was: 'Softwareentwickler' }, { was: 'Softwareentwickler' }],
  ] as const) {
    it(`${key}: offers the column table and inserts an object entry validate-portals.mjs accepts`, async () => {
      const ops = await mountEmpty(key);
      expect(host!.textContent).not.toContain('Empty list.');
      for (const [col, v] of Object.entries(cells)) await fill(`New ${key} ${col}`, v);
      await addRow();
      expect(ops).toEqual([{ op: 'insert', path: [key], value: expected }]);
      const run = validate({ [key]: [expected] });
      expect(run.stdout + run.stderr).toContain('0 errors');
      expect(run.status).toBe(0);
    });
  }
});

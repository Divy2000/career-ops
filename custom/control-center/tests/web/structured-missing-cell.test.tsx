// Settings > Portals > Structured: most tracked companies have no `enabled` key, so their cell is blank. Typing false
// there must save the boolean the scanners test (`enabled === false`), not the text "false" (R8-02).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { YamlOp } from '@shared/api';
import { KeyEditor } from '@web/features/settings/StructuredEditor';
import { PORTAL_RULES, PORTAL_SECTIONS } from '@web/features/settings/PortalsEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const COLUMNS = PORTAL_SECTIONS.find((s) => s.key === 'tracked_companies')!.columns;

let host: HTMLElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

async function mount(rows: Array<Record<string, unknown>>): Promise<YamlOp[]> {
  const ops: YamlOp[] = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(KeyEditor, { path: ['tracked_companies'], value: rows, onOp: (op: YamlOp) => ops.push(op), rules: PORTAL_RULES, columnsHint: COLUMNS })));
  return ops;
}

async function typeAndBlur(label: string, text: string) {
  const input = host!.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(input, label).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

const acme = { name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme', enabled: true };
const beta = { name: 'Beta', careers_url: 'https://job-boards.greenhouse.io/beta' };

describe('a blank cell in a structured Portals table', () => {
  it('the scanners pause a company only on the boolean false', () => {
    // scan.mjs and validate-portals.mjs both test `enabled === false`, so the text "false" leaves the company scanned.
    expect(fs.readFileSync(path.join(CODE_ROOT, 'scan.mjs'), 'utf8')).toMatch(/enabled === false/);
    expect(fs.readFileSync(path.join(CODE_ROOT, 'validate-portals.mjs'), 'utf8')).toMatch(/enabled === false/);
  });

  it('typing false in a blank enabled cell, where another row has a boolean, saves the boolean false', async () => {
    const ops = await mount([acme, beta]);
    await typeAndBlur('enabled of Beta', 'false');
    expect(ops).toEqual([{ op: 'set', path: ['tracked_companies', 1, 'enabled'], value: false }]);
  });

  it('typing true or false in a blank cell of a column no row has yet saves a boolean, as Add row does', async () => {
    const ops = await mount([beta]);
    await typeAndBlur('enabled of Beta', 'false');
    expect(ops).toEqual([{ op: 'set', path: ['tracked_companies', 0, 'enabled'], value: false }]);
  });

  it('a blank text cell still saves text, and leaving a blank cell blank saves nothing', async () => {
    const ops = await mount([acme, beta]);
    await typeAndBlur('provider of Beta', 'greenhouse');
    await typeAndBlur('api of Beta', '');
    await typeAndBlur('enabled of Beta', '');
    expect(ops).toEqual([{ op: 'set', path: ['tracked_companies', 1, 'provider'], value: 'greenhouse' }]);
  });
});

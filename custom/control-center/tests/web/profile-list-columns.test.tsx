// The profile's lists of objects (target_roles.archetypes as {name, level, fit}, narrative.proof_points as
// {name, url, hero_metric}, cover_letter.language_learning) start empty in the "Add <section>" skeleton. The form must
// offer their columns and insert objects, not a list of bare strings that providers/_profile-keywords.mjs reads as
// nothing (it maps archetypes to a.name) (SW3-web-b-04).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { YamlOp } from '@shared/api';
import { KeyEditor } from '@web/features/settings/StructuredEditor';
import { PROFILE_LIST_COLUMNS, PROFILE_SECTIONS } from '@web/features/settings/ProfileForm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const skeleton = (key: string) => PROFILE_SECTIONS.find((s) => s.key === key)!.empty;

async function render(key: string) {
  const ops: YamlOp[] = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(KeyEditor, { path: [key], value: skeleton(key), onOp: (op: YamlOp) => ops.push(op), columnsAt: PROFILE_LIST_COLUMNS })));
  return ops;
}
async function fill(label: string, value: string) {
  const el = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  expect(el, label).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
// target_roles has one list of objects (primary is a list of strings), so its only Add row is the archetypes one.
const addRow = () => act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Add row')!.click());

describe('profile lists of objects', () => {
  it('Add target_roles: archetypes offers name, level and fit, and a new archetype is an object', async () => {
    const ops = await render('target_roles');
    await fill('New target_roles.archetypes name', 'AI Engineer');
    await fill('New target_roles.archetypes fit', 'primary');
    await addRow();
    expect(ops).toEqual([{ op: 'insert', path: ['target_roles', 'archetypes'], value: { name: 'AI Engineer', fit: 'primary' } }]);
  });

  it('Add narrative: proof_points offers name, url and hero_metric', async () => {
    await render('narrative');
    for (const col of ['name', 'url', 'hero_metric']) expect(host.querySelector(`[aria-label="New narrative.proof_points ${col}"]`), col).not.toBeNull();
  });

  it('Add cover_letter: language_learning offers its columns', async () => {
    await render('cover_letter');
    for (const col of ['language', 'current_level', 'target_level', 'target_date', 'sentence']) expect(host.querySelector(`[aria-label="New cover_letter.language_learning ${col}"]`), col).not.toBeNull();
  });
});

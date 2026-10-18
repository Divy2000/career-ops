// Settings > structured editors (R35-feat-c-L2-02): adding to a numeric list or a numeric table column takes the type of
// the values already there, so text that is not a number must be refused, as ScalarInput refuses it, instead of queuing
// NaN, which the save serializes as null in the YAML.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { YamlOp } from '@shared/api';
import { ObjectTable, ScalarList } from '@web/features/settings/StructuredEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let ops: YamlOp[];
const sink = (op: YamlOp) => ops.push(op);

beforeEach(() => {
  ops = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function type(label: string, text: string) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const click = (name: string) => act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!.click());
const alertText = () => host.querySelector('[role="alert"]')?.textContent ?? '';

describe('adding to a numeric list', () => {
  beforeEach(async () => {
    await act(async () => root.render(createElement(ScalarList, { path: ['days'], items: [30, 60], onOp: sink })));
  });

  for (const text of ['90 days', '1,000', '1e999']) {
    it(`given ${JSON.stringify(text)}, when Add is pressed, then nothing is inserted and the list says it must be a number`, async () => {
      await type('Add to days', text);
      await click('Add');
      expect(ops).toEqual([]);
      expect(alertText()).toMatch(/must be a number/);
    });
  }

  it('given a number, when Add is pressed, then it is inserted as a number', async () => {
    await type('Add to days', '90');
    await click('Add');
    expect(ops).toEqual([{ op: 'insert', path: ['days'], value: 90 }]);
    expect(alertText()).toBe('');
  });
});

describe('adding a row with a numeric column', () => {
  beforeEach(async () => {
    await act(async () => root.render(createElement(ObjectTable, { path: ['tracked_companies'], rows: [{ name: 'Acme', getro_collection: 4283 }], onOp: sink })));
  });

  it('given non-numeric text in the numeric column, when Add row is pressed, then nothing is inserted and the column is named', async () => {
    await type('New tracked_companies name', 'Globex');
    await type('New tracked_companies getro_collection', 'n/a');
    await click('Add row');
    expect(ops).toEqual([]);
    expect(alertText()).toMatch(/getro_collection: must be a number/);
  });

  it('given a number in the numeric column, when Add row is pressed, then the row is inserted with it', async () => {
    await type('New tracked_companies name', 'Globex');
    await type('New tracked_companies getro_collection', '17');
    await click('Add row');
    expect(ops).toEqual([{ op: 'insert', path: ['tracked_companies'], value: { name: 'Globex', getro_collection: 17 } }]);
  });
});

describe('filling a blank cell in a numeric column', () => {
  it('given a number too large to store, when it is committed, then it is refused rather than saved as null', async () => {
    await act(async () => root.render(createElement(ObjectTable, { path: ['tracked_companies'], rows: [{ name: 'Acme', getro_collection: 4283 }, { name: 'Globex' }], onOp: sink })));
    await type('getro_collection of Globex', '1e999');
    await act(async () => host.querySelector('input[aria-label="getro_collection of Globex"]')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(ops).toEqual([]);
    expect(alertText()).toMatch(/must be a number/);
  });
});

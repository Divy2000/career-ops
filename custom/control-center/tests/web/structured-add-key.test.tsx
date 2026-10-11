// Settings > Profile > Form > Add key: text that only looks numeric to Number() stays text, so a phone number keeps its
// "+", an id keeps its leading zeros and a hex-looking value is not converted (R18-feat-c-L2-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { YamlOp } from '@shared/api';
import { KeyEditor } from '@web/features/settings/StructuredEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

async function addKey(key: string, value: string): Promise<YamlOp[]> {
  const ops: YamlOp[] = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(KeyEditor, { path: ['candidate'], value: { full_name: 'Ada' }, onOp: (op: YamlOp) => ops.push(op) })));
  const type = async (label: string, text: string) => {
    const el = host!.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  await type('New key under candidate', key);
  await type('Value for new key under candidate', value);
  const button = [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Add key')!;
  await act(async () => button.click());
  return ops;
}

describe('Add key value types', () => {
  it.each(['+14155550123', '0049301234567', '0x1F', '+0530', '1e3', ' 12 34'])('keeps %j as text', async (text) => {
    expect(await addKey('phone', text)).toEqual([{ op: 'set', path: ['candidate', 'phone'], value: text.trim() }]);
  });

  it.each([
    ['42', 42],
    ['-7', -7],
    ['0', 0],
    ['3.5', 3.5],
  ])('reads plain decimal %j as a number', async (text, n) => {
    expect(await addKey('years', text)).toEqual([{ op: 'set', path: ['candidate', 'years'], value: n }]);
  });

  it('still reads true/false as a switch', async () => {
    expect(await addKey('remote', 'true')).toEqual([{ op: 'set', path: ['candidate', 'remote'], value: true }]);
  });
});

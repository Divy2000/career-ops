// Settings > Profile and the other structured editors: clearing a number field must not save 0
// (auto_pdf_score_threshold: 0 means "make a PDF for every offer"). R7-18.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { YamlOp } from '@shared/api';
import { ScalarInput } from '@web/features/settings/StructuredEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let ops: YamlOp[];

beforeEach(async () => {
  ops = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(ScalarInput, { path: ['auto_pdf_score_threshold'], value: 4, onOp: (op: YamlOp) => ops.push(op) })));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function typeAndBlur(text: string) {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="auto_pdf_score_threshold"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

describe('a number field in a structured editor', () => {
  for (const text of ['', '   ']) {
    it(`refuses ${JSON.stringify(text)} instead of saving 0`, async () => {
      await typeAndBlur(text);
      expect(ops).toEqual([]);
      expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/number/);
    });
  }

  it('still saves a typed number, 0 included', async () => {
    await typeAndBlur('0');
    expect(ops).toEqual([{ op: 'set', path: ['auto_pdf_score_threshold'], value: 0 }]);
  });
});

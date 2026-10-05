// Apply > drafted answers: what a select shows is what "Fill real form" sends. A drafted value that is not one of the
// options (the envelope's value defaults to '') must not show as the first option while '' is what gets sent (SW-web-a-03).
import { createElement, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnswersForm, type AnswerField } from '@web/features/apply/ApplyPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let latest: AnswerField[];

function Harness({ initial }: { initial: AnswerField[] }) {
  const [fields, setFields] = useState(initial);
  latest = fields;
  return createElement(AnswersForm, { fields, onChange: setFields });
}

const field = (value: string): AnswerField => ({ id: 'spons', label: 'Will you need sponsorship?', type: 'select', options: ['No', 'Yes'], required: false, value, needsConfirmation: true });

async function mount(initial: AnswerField[]) {
  await act(async () => root.render(createElement(Harness, { initial })));
  return host.querySelector('select')!;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const shown = (select: HTMLSelectElement) => select.options[select.selectedIndex]?.textContent;

describe('Apply drafted answers: select fields', () => {
  it('a select with no drafted value shows that it is unanswered, not the first option', async () => {
    const select = await mount([field('')]);
    expect(select.value).toBe('');
    expect(shown(select)).toBe('Choose an answer');
    expect(latest[0]!.value).toBe('');
  });

  it('a drafted value that is not one of the options shows as drafted', async () => {
    const select = await mount([field('Not sure')]);
    expect(select.value).toBe('Not sure');
    expect(shown(select)).toBe('Not sure');
  });

  it('picking an option holds it, and the select then lists only the real options', async () => {
    const select = await mount([field('')]);
    await act(async () => {
      select.value = 'Yes';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(latest[0]!.value).toBe('Yes');
    expect(shown(select)).toBe('Yes');
    expect([...select.options].map((o) => o.value)).toEqual(['No', 'Yes']);
  });

  it('a drafted value that is one of the options shows as is, with no extra entry', async () => {
    const select = await mount([field('No')]);
    expect(select.value).toBe('No');
    expect([...select.options].map((o) => o.value)).toEqual(['No', 'Yes']);
  });
});

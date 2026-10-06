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

describe('Apply drafted answers: any field with fixed options (SW7-web-a-05)', () => {
  it('a combobox or other single-choice field with options is a choice between them, not free text', async () => {
    for (const type of ['combobox', 'dropdown']) {
      const select = await mount([{ ...field('No'), type }]);
      expect(select, type).not.toBeNull();
      expect([...select.options].map((o) => o.value), type).toEqual(['No', 'Yes']);
      expect(select.value, type).toBe('No');
      expect(host.querySelector('input'), type).toBeNull();
    }
  });

  it('a checkbox group is shown as set by hand on the form: its options and the drafted answer, nothing to edit (review fix)', async () => {
    await act(async () => root.render(createElement(Harness, { initial: [{ id: 'langs', label: 'Languages you speak', type: 'checkbox', options: ['English', 'German', 'French'], required: false, value: 'English, German', needsConfirmation: false }] })));
    const manual = host.querySelector('[data-manual-field="langs"]')!;
    expect(manual).not.toBeNull();
    expect([...manual.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['English', 'German', 'French']);
    expect(manual.textContent).toContain('Set this on the form yourself');
    expect(manual.textContent).toContain('Drafted: English, German');
    expect(host.querySelector('select, input, textarea')).toBeNull();
  });

  it('a radio group is shown as set by hand on the form too: the fill turn may skip radios (modes/apply.md, Lever), so no choice here is one the app sets (review fix 2)', async () => {
    await act(async () => root.render(createElement(Harness, { initial: [{ ...field('No'), type: 'radio' }] })));
    const manual = host.querySelector('[data-manual-field="spons"]')!;
    expect(manual).not.toBeNull();
    expect([...manual.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['No', 'Yes']);
    expect(manual.textContent).toContain('Set this on the form yourself');
    expect(manual.textContent).toContain('Drafted: No');
    expect(host.querySelector('select, input, textarea')).toBeNull();
  });

  it('a single checkbox or a radio with no options listed is set by hand too, with its drafted answer (review fix 3)', async () => {
    for (const [type, options] of [['checkbox', undefined], ['radio', []]] as const) {
      await act(async () => root.render(createElement(Harness, { initial: [{ ...field('Yes'), type, options: options as string[] | undefined }] })));
      const manual = host.querySelector('[data-manual-field="spons"]');
      expect(manual, type).not.toBeNull();
      expect(manual!.textContent, type).toContain('Set this on the form yourself');
      expect(manual!.textContent, type).toContain('Drafted: Yes');
      expect(manual!.querySelector('ul'), type).toBeNull();
      expect(host.querySelector('select, input, textarea'), type).toBeNull();
    }
  });

  it('any other field whose options list is empty stays a text box', async () => {
    await act(async () => root.render(createElement(Harness, { initial: [{ ...field('x'), type: 'combobox', options: [] }] })));
    expect(host.querySelector('select')).toBeNull();
    expect(host.querySelector('input')!.value).toBe('x');
  });
});

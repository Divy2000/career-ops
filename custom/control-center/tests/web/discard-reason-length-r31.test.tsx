// tracker.setStatus refuses a note over STATUS_NOTE_MAX characters: the Discard picker refuses a longer "Other" reason
// before the user confirms it, as the Ask drawer does (R31-feat-c-L2-02).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrackerRow } from '@shared/api';
import { STATUS_NOTE_MAX } from '@shared/tracker-status';
import { DiscardReasonPicker } from '@web/features/tracker/StatusControl';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const ROW = { num: 4, company: 'Initech Cloud', summary: null } as unknown as TrackerRow;
const PREFIX = 'DISCARD: ';

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function typeOther(text: string, notes: string[]) {
  await act(async () => root.render(createElement(DiscardReasonPicker, { state: 'Discarded', row: ROW, busy: false, onConfirm: (n: string) => void notes.push(n), onCancel: () => undefined })));
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Discard reason"]')!;
  await act(async () => {
    select.value = '__other';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Other reason"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Confirm'))!;
}

describe('discard reason length', () => {
  it('given an Other reason that makes the note longer than the server takes, then Confirm is off and says why', async () => {
    const notes: string[] = [];
    const confirm = await typeOther('x'.repeat(STATUS_NOTE_MAX - PREFIX.length + 1), notes);
    expect(confirm.disabled).toBe(true);
    await act(async () => confirm.click());
    expect(notes).toEqual([]);
    expect(host.textContent).toContain(`at most ${STATUS_NOTE_MAX - PREFIX.length} characters`);
  });

  it('given an Other reason that fills the note exactly, then Confirm records it', async () => {
    const notes: string[] = [];
    const reason = 'x'.repeat(STATUS_NOTE_MAX - PREFIX.length);
    const confirm = await typeOther(reason, notes);
    expect(confirm.disabled).toBe(false);
    await act(async () => confirm.click());
    expect(notes).toEqual([`${PREFIX}${reason}`]);
  });
});

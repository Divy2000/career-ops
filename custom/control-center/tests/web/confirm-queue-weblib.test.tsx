// A confirm asked while another is open waits its turn: the open dialog keeps the text the user is reading, and every
// caller's promise settles with its own answer (R13-shared-comp-L3-02).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfirmProvider, useConfirm, type ConfirmOptions } from '@web/components/ConfirmDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let ask: (opts: ConfirmOptions) => Promise<boolean>;

function Probe() {
  ask = useConfirm();
  return null;
}

beforeEach(async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(ConfirmProvider, null, createElement(Probe))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const title = () => document.querySelector('.dialog__title')?.textContent;
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)!;

describe('overlapping confirms', () => {
  it('queues the second confirm behind the open one and settles both', async () => {
    const answers: Record<string, boolean> = {};
    await act(async () => void ask({ title: 'Set row #4 to Applied', confirmLabel: 'Do it' }).then((a) => (answers.first = a)));
    await act(async () => void ask({ title: 'Evaluate 3 postings at Acme', confirmLabel: 'Do it' }).then((a) => (answers.second = a)));
    expect(title()).toBe('Set row #4 to Applied');
    await act(async () => button('Do it').click());
    expect(answers.first).toBe(true);
    expect(title()).toBe('Evaluate 3 postings at Acme');
    await act(async () => button('Cancel').click());
    expect(answers.second).toBe(false);
    expect(title()).toBeUndefined();
  });

  it('a double click on the open confirm answers only that one: its second click never answers the confirm shown next in its place (R31-shared-comp-X-01)', async () => {
    const answers: Record<string, boolean> = {};
    await act(async () => void ask({ title: 'Evaluate posting A', confirmLabel: 'Do it' }).then((a) => (answers.first = a)));
    await act(async () => void ask({ title: 'Generate PDF for row 3', confirmLabel: 'Do it' }).then((a) => (answers.second = a)));
    const click = (text: string, detail: number) => button(text).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
    await act(async () => click('Do it', 1));
    await act(async () => click('Do it', 2));
    expect(answers.first).toBe(true);
    expect(answers.second).toBeUndefined();
    expect(title()).toBe('Generate PDF for row 3');
    // A fresh click still answers the next one.
    await act(async () => click('Do it', 1));
    expect(answers.second).toBe(true);
  });

  it('a double click on Cancel cancels only the open confirm, never the one shown next (R31-shared-comp-X-01)', async () => {
    const answers: Record<string, boolean> = {};
    await act(async () => void ask({ title: 'First', confirmLabel: 'Do it' }).then((a) => (answers.first = a)));
    await act(async () => void ask({ title: 'Second', confirmLabel: 'Do it' }).then((a) => (answers.second = a)));
    const click = (text: string, detail: number) => button(text).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
    await act(async () => click('Cancel', 1));
    await act(async () => click('Cancel', 2));
    expect(answers.first).toBe(false);
    expect(answers.second).toBeUndefined();
    expect(title()).toBe('Second');
  });
});

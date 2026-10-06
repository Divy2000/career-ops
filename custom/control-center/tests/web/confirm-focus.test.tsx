// A confirm dialog opened from the keyboard must not be confirmed by the same key. A destructive or paid confirm puts
// focus on Cancel (the WAI-ARIA alert dialog practice), so a held or double-pressed Enter cancels (SW4-web-a-02).
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

const focused = () => (document.activeElement as HTMLElement | null)?.textContent?.trim();

describe('confirm dialog focus', () => {
  it('a destructive or paid confirm opens with Cancel focused, and Enter on it declines', async () => {
    let answer: boolean | undefined;
    await act(async () => void ask({ title: 'Delete tracker row', body: 'Removes the row.', confirmLabel: 'Do it', danger: true }).then((a) => (answer = a)));
    expect(focused()).toBe('Cancel');
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    expect(answer).toBe(false);
  });

  it('a plain confirm still opens with its confirm button focused', async () => {
    await act(async () => void ask({ title: 'Start them?', confirmLabel: 'Start them' }));
    expect(focused()).toBe('Start them');
  });
});

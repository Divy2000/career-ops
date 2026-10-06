// A shortlist score is the rank plus the sponsorship adjustment (custom/pipeline/shortlist.mjs: strong +0.5 ... none
// -1.5), so it can pass 5 or go below 0. It shows as a plain number, never "5.5/5" or "-1.3/5" (SW3-libs-02).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ShortlistScore } from '@web/components/ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function render(score: number | null) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(ShortlistScore, { score })));
  return host.firstElementChild as HTMLElement;
}

describe('ShortlistScore', () => {
  it('shows a score above 5 or below 0 as a plain number, saying what it adds up', async () => {
    const above = await render(5.5);
    expect(above.textContent).toBe('5.5');
    expect(above.getAttribute('title')).toBe('Shortlist score 5.5: the rank plus the sponsorship adjustment');
    await act(async () => root.unmount());
    host.remove();
    expect((await render(-1.3)).textContent).toBe('-1.3');
  });

  it('says when there is no score', async () => {
    expect((await render(null)).textContent).toBe('no score');
  });
});

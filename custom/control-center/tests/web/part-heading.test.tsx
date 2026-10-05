import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PartHeading } from '../../web/features/tutorials/PartHeading';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

const tutorial = { title: 'Parts tour', description: 'A tour in three parts.' };
const part = (description: string | null) => ({ title: 'Today and the inbox', description });

async function render(props: Parameters<typeof PartHeading>[0]) {
  await act(async () => root.render(createElement(PartHeading, props)));
}
const text = (selector: string) => host.querySelector(selector)?.textContent ?? null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('PartHeading', () => {
  it('given a part with a description, when rendered, then it shows "Part N of M", the part title and the part description, in that order', async () => {
    await render({ tutorial, part: part('Where new roles land.'), number: 2, total: 3 });
    expect([...host.querySelectorAll('p, h2')].map((el) => el.textContent)).toEqual(['Part 2 of 3', 'Today and the inbox', 'Where new roles land.']);
  });

  it('given a part without a description, when rendered, then it falls back to the tutorial description', async () => {
    await render({ tutorial, part: part(null), number: 3, total: 3 });
    expect(text('.tut__description')).toBe('A tour in three parts.');
  });

  it('given a tutorial with one video, when rendered, then it shows the tutorial title and description and no part line', async () => {
    await render({ tutorial, part: { title: 'Parts tour', description: 'A tour in three parts.' }, number: 1, total: 1 });
    expect(text('.tut__eyebrow')).toBeNull();
    expect(text('h2')).toBe('Parts tour');
    expect(text('.tut__description')).toBe('A tour in three parts.');
  });

  it('given a parts manifest with exactly one part that has its own description, when rendered, then that description shows, with no part line', async () => {
    await render({ tutorial, part: part('Where new roles land.'), number: 1, total: 1 });
    expect(text('.tut__description')).toBe('Where new roles land.');
    expect(text('.tut__eyebrow')).toBeNull();
  });

  it('given neither the part nor the tutorial has a description, when rendered, then no description line is drawn', async () => {
    await render({ tutorial: { title: 'Parts tour', description: '' }, part: part(null), number: 1, total: 2 });
    expect(host.querySelector('.tut__description')).toBeNull();
  });

  it('puts an action (the captions button) next to the title', async () => {
    await render({ tutorial, part: part(null), number: 1, total: 2, action: createElement('button', { type: 'button' }, 'Captions: on') });
    expect(host.querySelector('h2')!.parentElement!.querySelector('button')!.textContent).toBe('Captions: on');
  });
});

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilePicker } from '@web/components/ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let picked: string[];
let valueSets: string[];

async function render() {
  picked = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(FilePicker, { label: 'Projects file', accept: '.json,.pdf', onFile: (f: File) => void picked.push(f.name) })));
}

// jsdom's file input reports value '' whatever is assigned, so reading value back cannot show
// the reset; record what the change handler writes instead.
const recorded = new WeakSet<HTMLInputElement>();
function recordValueSets(input: HTMLInputElement) {
  valueSets = [];
  if (recorded.has(input)) return;
  recorded.add(input);
  let owner: object | null = input;
  let desc: PropertyDescriptor | undefined;
  while (owner && !(desc = Object.getOwnPropertyDescriptor(owner, 'value'))) owner = Object.getPrototypeOf(owner);
  const inner = desc!;
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() {
      return inner.get!.call(this);
    },
    set(v: string) {
      valueSets.push(v);
      inner.set!.call(this, v);
    },
  });
}

async function choose(name: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  recordValueSets(input);
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [new File(['x'], name)], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

describe('FilePicker', () => {
  it('is a labelled file input behind a styled button, showing that no file is chosen yet', async () => {
    await render();
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.getAttribute('aria-label')).toBe('Projects file');
    expect(input.accept).toBe('.json,.pdf');
    expect(input.className).toContain('sr-only');
    expect(host.querySelector('.file-picker__button')?.textContent).toBe('Choose file');
    expect(host.querySelector('.file-picker__name')?.textContent).toBe('No file chosen');
  });

  it('shows the chosen file name and hands the file over, and the same file can be chosen again', async () => {
    await render();
    await choose('projects.json');
    expect(host.querySelector('.file-picker__name')?.textContent).toBe('projects.json');
    expect(valueSets).toEqual(['']);
    await choose('projects.json');
    expect(valueSets).toEqual(['']);
    expect(picked).toEqual(['projects.json', 'projects.json']);
  });
});

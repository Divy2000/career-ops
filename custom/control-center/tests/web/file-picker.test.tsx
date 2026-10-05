import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilePicker } from '@web/components/ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let picked: string[];

async function render() {
  picked = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(FilePicker, { label: 'Projects file', accept: '.json,.pdf', onFile: (f: File) => void picked.push(f.name) })));
}

async function choose(name: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
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
    expect(host.querySelector<HTMLInputElement>('input[type="file"]')!.value).toBe('');
    await choose('projects.json');
    expect(picked).toEqual(['projects.json', 'projects.json']);
  });
});

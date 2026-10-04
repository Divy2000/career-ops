import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

async function mount(stored?: string) {
  const data = new Map<string, string>(stored ? [['cc.theme', stored]] : []);
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
  const mm = () => ({ matches: true, media: '', addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('localStorage', storage);
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
  vi.stubGlobal('matchMedia', mm);
  Object.defineProperty(window, 'matchMedia', { value: mm, configurable: true, writable: true });
  vi.resetModules();
  const { AppearanceSetting } = await import('@web/components/AppearanceSetting');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(AppearanceSetting)));
  return data;
}

const group = () => host.querySelector<HTMLElement>('[role="radiogroup"]')!;
const radios = () => [...host.querySelectorAll<HTMLElement>('[role="radio"]')];
const key = (el: Element, k: string) => act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

describe('Appearance setting', () => {
  it('is a labelled radiogroup of three preview cards with the current mode checked and the only tab stop', async () => {
    await mount('light');
    expect(group().getAttribute('aria-label')).toBe('Appearance');
    expect(radios().map((r) => [r.getAttribute('aria-label'), r.getAttribute('aria-checked'), r.tabIndex])).toEqual([
      ['Auto', 'false', -1],
      ['Light', 'true', 0],
      ['Dark', 'false', -1],
    ]);
  });

  it('draws each preview under its own theme (Auto is a diagonal split of both) and hides it from assistive tech', async () => {
    await mount();
    const previews = radios().map((r) => [...r.querySelectorAll('[data-theme]')].map((p) => p.getAttribute('data-theme')));
    expect(previews).toEqual([['light', 'dark'], ['light'], ['dark']]);
    expect(host.querySelectorAll('.theme-preview[aria-hidden="true"]').length).toBe(3);
  });

  it('clicking a card selects it and persists the choice', async () => {
    const data = await mount();
    await act(async () => void radios()[2]!.click());
    expect(radios()[2]!.getAttribute('aria-checked')).toBe('true');
    expect(data.get('cc.theme')).toBe('dark');
  });

  it('arrow keys move the choice and the focus together, wrapping at the ends', async () => {
    const data = await mount('auto');
    radios()[0]!.focus();
    await key(radios()[0]!, 'ArrowRight');
    expect(data.get('cc.theme')).toBe('light');
    expect(document.activeElement).toBe(radios()[1]);
    await key(radios()[1]!, 'ArrowDown');
    expect(data.get('cc.theme')).toBe('dark');
    await key(radios()[2]!, 'ArrowRight');
    expect(data.get('cc.theme')).toBe('auto');
    expect(document.activeElement).toBe(radios()[0]);
    await key(radios()[0]!, 'ArrowLeft');
    expect(data.get('cc.theme')).toBe('dark');
    await key(radios()[2]!, 'ArrowUp');
    expect(data.get('cc.theme')).toBe('light');
  });
});

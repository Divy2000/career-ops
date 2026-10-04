import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function installEnv(opts: { stored?: string; systemDark?: boolean } = {}) {
  const data = new Map<string, string>(opts.stored ? [['cc.theme', opts.stored]] : []);
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
  const mm = () => ({ matches: opts.systemDark ?? true, media: '', addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('localStorage', storage);
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
  vi.stubGlobal('matchMedia', mm);
  Object.defineProperty(window, 'matchMedia', { value: mm, configurable: true, writable: true });
  return data;
}

let host: HTMLElement;
let root: Root;

async function mount(opts: { stored?: string; systemDark?: boolean } = {}) {
  const data = installEnv(opts);
  vi.resetModules();
  const { ThemeSwitcher } = await import('@web/components/ThemeSwitcher');
  const theme = await import('@web/lib/theme');
  // Something to tab to and click, outside the switcher.
  host = document.createElement('div');
  host.innerHTML = '<button id="before">before</button><div id="mount"></div><button id="after">after</button>';
  document.body.append(host);
  root = createRoot(host.querySelector('#mount')!);
  await act(async () => root.render(createElement(ThemeSwitcher)));
  return { data, theme };
}

const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
const menu = () => host.querySelector<HTMLElement>('[role="menu"]');
const items = () => [...host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
const key = (el: Element, k: string) => act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
const click = (el: Element) => act(async () => void (el as HTMLElement).click());

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

describe('ThemeSwitcher trigger', () => {
  it.each([
    [undefined, true, 'Theme: Auto (dark)'],
    [undefined, false, 'Theme: Auto (light)'],
    ['light', true, 'Theme: Light'],
    ['dark', false, 'Theme: Dark'],
  ])('stored %s with system dark=%s is named "%s" and is a closed menu button', async (stored, systemDark, name) => {
    await mount({ stored, systemDark });
    const t = trigger();
    expect(t.textContent).toBe(name);
    expect(t.querySelector('.sr-only')?.textContent).toBe(name);
    expect(t.getAttribute('aria-expanded')).toBe('false');
    expect(menu()).toBeNull();
  });

  it('opens a menu of three radio items (not a dialog) on click, with the current mode checked and focused', async () => {
    await mount({ stored: 'light' });
    await click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(menu()?.getAttribute('aria-label')).toBe('Theme');
    expect(items().map((i) => [i.textContent, i.getAttribute('aria-checked')])).toEqual([
      ['Auto', 'false'],
      ['Light', 'true'],
      ['Dark', 'false'],
    ]);
    expect(document.activeElement).toBe(items()[1]);
    expect(host.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
  });

  it('ArrowDown on the trigger opens on the checked item, ArrowUp on the last one', async () => {
    await mount({ stored: 'light' });
    await key(trigger(), 'ArrowDown');
    expect(document.activeElement).toBe(items()[1]);
    await key(document.activeElement!, 'Escape');
    await key(trigger(), 'ArrowUp');
    expect(document.activeElement).toBe(items()[2]);
  });

  it('clicking the trigger again closes the menu', async () => {
    await mount();
    await click(trigger());
    await click(trigger());
    expect(menu()).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });
});

describe('ThemeSwitcher menu keyboard', () => {
  it('Up and Down move through the items and wrap, Home and End jump to the ends', async () => {
    await mount({ stored: 'auto' });
    await click(trigger());
    const [auto, light, dark] = items() as [HTMLElement, HTMLElement, HTMLElement];
    expect(document.activeElement).toBe(auto);
    await key(auto, 'ArrowUp');
    expect(document.activeElement).toBe(dark);
    await key(dark, 'ArrowDown');
    expect(document.activeElement).toBe(auto);
    await key(auto, 'ArrowDown');
    expect(document.activeElement).toBe(light);
    await key(light, 'End');
    expect(document.activeElement).toBe(dark);
    await key(dark, 'Home');
    expect(document.activeElement).toBe(auto);
  });

  it('Enter on an item selects it, closes the menu, persists the choice and returns focus to the trigger', async () => {
    const { data, theme } = await mount({ stored: 'auto', systemDark: true });
    await click(trigger());
    await key(items()[0]!, 'ArrowDown');
    await click(document.activeElement!);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(data.get('cc.theme')).toBe('light');
    expect(theme.getThemeState()).toMatchObject({ mode: 'light', resolved: 'light' });
    expect(trigger().textContent).toBe('Theme: Light');
  });

  it('Escape closes without changing the theme and returns focus to the trigger', async () => {
    const { data } = await mount({ stored: 'dark' });
    await click(trigger());
    await key(items()[0]!, 'ArrowUp');
    await key(document.activeElement!, 'Escape');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(data.get('cc.theme')).toBe('dark');
  });

  it('Tab closes without changing the theme and leaves focus on the trigger so the browser moves on from there', async () => {
    const { data } = await mount({ stored: 'dark' });
    await click(trigger());
    await key(document.activeElement!, 'Tab');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(data.get('cc.theme')).toBe('dark');
  });

  it('a press outside the switcher closes it without changing the theme', async () => {
    const { data } = await mount({ stored: 'dark' });
    await click(trigger());
    await act(async () => void host.querySelector('#after')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(menu()).toBeNull();
    expect(data.get('cc.theme')).toBe('dark');
  });

  it('a press inside the menu does not close it', async () => {
    await mount();
    await click(trigger());
    await act(async () => void menu()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(menu()).not.toBeNull();
  });
});

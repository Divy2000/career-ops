import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpNext } from '../../web/features/tutorials/UpNext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let onPlay: ReturnType<typeof vi.fn<() => void>>;
let onCancel: ReturnType<typeof vi.fn<() => void>>;

function reducedMotion(on: boolean) {
  const mm = (q: string) => ({ matches: on && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(window, 'matchMedia', { value: mm, configurable: true, writable: true });
}

async function mount() {
  await act(async () => root.render(createElement(UpNext, { next: { title: 'Apply and follow up' }, number: 4, total: 8, onPlay, onCancel })));
}

const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;
const countdown = () => host.querySelector('.tut-upnext__count')!.textContent;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<button id="before">before</button>';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  onPlay = vi.fn<() => void>();
  onCancel = vi.fn<() => void>();
  reducedMotion(false);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('UpNext', () => {
  it('names the next part and its number', async () => {
    await mount();
    expect(host.textContent).toContain('Up next');
    expect(host.textContent).toContain('Part 4 of 8');
    expect(host.textContent).toContain('Apply and follow up');
  });

  it('announces the next part once through a polite live region, without the ticking countdown', async () => {
    await mount();
    const live = host.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe('Up next: part 4 of 8, Apply and follow up. Playing in 8 seconds.');
    await act(async () => void vi.advanceTimersByTime(3000));
    expect(live.textContent).toBe('Up next: part 4 of 8, Apply and follow up. Playing in 8 seconds.');
    expect(live.contains(host.querySelector('.tut-upnext__count'))).toBe(false);
  });

  it('does not take focus', async () => {
    const before = document.getElementById('before')!;
    before.focus();
    await mount();
    expect(document.activeElement).toBe(before);
  });

  it('counts down from 8 seconds and plays the next part at 0', async () => {
    await mount();
    expect(countdown()).toBe('Playing in 8 s');
    await act(async () => void vi.advanceTimersByTime(3000));
    expect(countdown()).toBe('Playing in 5 s');
    expect(onPlay).not.toHaveBeenCalled();
    await act(async () => void vi.advanceTimersByTime(5000));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it('plays at once from Play now', async () => {
    await mount();
    await act(async () => button('Play now').click());
    expect(onPlay).toHaveBeenCalledTimes(1);
    await act(async () => void vi.advanceTimersByTime(9000));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it('cancels from Cancel and from Escape', async () => {
    await mount();
    await act(async () => button('Cancel').click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    await act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('draws the draining bar with motion allowed, and only the countdown text under reduced motion', async () => {
    await mount();
    expect(host.querySelector('.tut-upnext__bar')).not.toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    reducedMotion(true);
    await mount();
    expect(host.querySelector('.tut-upnext__bar')).toBeNull();
    expect(countdown()).toBe('Playing in 8 s');
  });
});

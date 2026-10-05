import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PartList } from '../../web/features/tutorials/PartList';
import type { TutorialPart } from '../../shared/api';
import type { TutorialProgress } from '../../web/lib/tutorial-progress';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const part = (id: string, title: string, short: string, duration: number): TutorialPart => ({
  id,
  title,
  short,
  duration,
  video: { file: `${id}.mp4`, url: `/m/${id}.mp4`, bytes: 1 },
  videoLight: null,
  subtitles: null,
  poster: null,
  posterLight: null,
  chapters: [{ title: `${short} chapter`, start: 0 }],
});

const parts = [part('start', 'Start here: safety and launch', 'Start here', 263.2), part('morning', 'Today and the inbox', 'Today & inbox', 305), part('tracker', 'The tracker', 'Tracker', 228)];

let host: HTMLElement;
let root: Root;
let onOpen: ReturnType<typeof vi.fn<(id: string) => void>>;

async function render(activeId: string, progress: TutorialProgress = {}) {
  await act(async () =>
    root.render(
      createElement(PartList, {
        parts,
        activeId,
        progress,
        hrefFor: (id: string) => `/tutorials?t=tour&part=${id}`,
        onOpen,
        activeChapters: createElement('ol', { className: 'chapters-under-test' }),
      }),
    ),
  );
}

const rows = () => [...host.querySelectorAll<HTMLAnchorElement>('a.tut-part__row')];
const row = (id: string) => host.querySelector<HTMLAnchorElement>(`a.tut-part__row[href="/tutorials?t=tour&part=${id}"]`)!;

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  onOpen = vi.fn<(id: string) => void>();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('PartList', () => {
  it('is headed Parts and lists every part with its number, short label and length, the full title as a tooltip', async () => {
    await render('start');
    expect(host.querySelector('h2')!.textContent).toBe('Parts');
    expect(rows().map((r) => [r.querySelector('.tut-part__badge')!.textContent, r.querySelector('.tut-part__label')!.textContent, r.querySelector('.tut-part__len')!.textContent])).toEqual([
      ['1', 'Start here', '4:23'],
      ['2', 'Today & inbox', '5:05'],
      ['3', 'Tracker', '3:48'],
    ]);
    expect(row('morning').title).toBe('Today and the inbox');
  });

  it('marks the active part and lists its chapters under it only', async () => {
    await render('morning');
    expect(row('morning').getAttribute('aria-current')).toBe('true');
    expect(row('start').hasAttribute('aria-current')).toBe(false);
    expect(host.querySelectorAll('.chapters-under-test')).toHaveLength(1);
    expect(row('morning').closest('li')!.querySelector('.chapters-under-test')).not.toBeNull();
  });

  it('shows a check for a watched part and a progress track for one under way, and says both', async () => {
    await render('start', { start: { at: 263, max: 263, done: true }, morning: { at: 152.5, max: 152.5, done: false } });
    expect(row('start').querySelector('.tut-part__badge')!.getAttribute('data-done')).toBe('true');
    expect(row('start').querySelector('.tut-part__badge')!.textContent).toBe('');
    expect(row('start').textContent).toContain(', watched');
    expect(row('morning').querySelector<HTMLElement>('.tut-part__fill')!.style.transform).toBe('scaleX(0.5)');
    expect(row('morning').textContent).toContain(', 50% watched');
    expect(row('tracker').querySelector<HTMLElement>('.tut-part__fill')!.style.transform).toBe('scaleX(0)');
    expect(row('tracker').textContent).not.toContain('watched');
  });

  it('counts the watched parts in the heading row', async () => {
    await render('start', { start: { at: 263, max: 263, done: true } });
    expect(host.querySelector('.tut-parts__count')!.textContent).toBe('1 of 3 watched');
  });

  it('opens a part on a plain click without leaving the page, and leaves modified clicks to the browser', async () => {
    await render('start');
    const plain = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await act(async () => void row('tracker').dispatchEvent(plain));
    expect(onOpen).toHaveBeenCalledWith('tracker');
    expect(plain.defaultPrevented).toBe(true);
    const meta = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true });
    row('morning').addEventListener('click', (e) => e.preventDefault());
    await act(async () => void row('morning').dispatchEvent(meta));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

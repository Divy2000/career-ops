// The player's capture-phase keydown must leave a focused button or link alone, so the theme menu (and a chapter
// button, a link) keeps its own keyboard: ArrowUp/Down move through the menu instead of changing chapters, and j/k/l/c
// no longer pause or seek while a button has focus (R17-feat-c-X-01).
import { describe, expect, it } from 'vitest';
import { playerSkipsKey } from '../../web/features/tutorials/TutorialsPage';

describe('playerSkipsKey', () => {
  it('leaves a focused button alone', () => {
    expect(playerSkipsKey('button')).toBe(true);
  });

  it('leaves a focused link alone', () => {
    expect(playerSkipsKey('link')).toBe(true);
  });

  it('acts on every other target (body, video, and the text-entry kinds keyAction already ignores)', () => {
    for (const target of ['body', 'input', 'textarea', 'select', 'editable']) expect(playerSkipsKey(target)).toBe(false);
  });
});

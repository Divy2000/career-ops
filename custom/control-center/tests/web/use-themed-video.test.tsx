import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwapHooks } from '@web/lib/media-swap';
import type { TutorialPart } from '@shared/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The swap controller is replaced by a stub that hands its hooks to the test, so the test plays the swap's part.
const swap = vi.hoisted(() => ({ hooks: null as SwapHooks | null }));
vi.mock('@web/lib/media-swap', () => ({
  createMediaSwap: (_el: unknown, hooks: SwapHooks) => {
    swap.hooks = hooks;
    return { swapTo: () => undefined, position: () => null, seekTo: () => undefined, noteSeek: () => undefined, dispose: () => undefined };
  },
  drawFreezeFrame: () => false,
}));

const { useThemedVideo } = await import('@web/features/tutorials/useThemedVideo');

const file = (name: string) => ({ file: name, url: `/media/${name}` });
const PART = { id: 'main', title: 'Tour', short: 'Tour', description: null, duration: null, video: { ...file('d.mp4'), bytes: 1 }, videoLight: null, subtitles: null, poster: null, posterLight: null, chapters: [] } as unknown as TutorialPart;

type Hook = ReturnType<typeof useThemedVideo>;
let host: HTMLElement;
let root: Root;
let latest: Hook;
const video = createRef<HTMLVideoElement>();
const cover = createRef<HTMLCanvasElement>();

function Harness() {
  latest = useThemedVideo(video, cover, PART, null);
  return createElement('div', null, createElement('video', { ref: video }), createElement('canvas', { ref: cover }));
}

beforeEach(async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('telling the swap\'s own restoring seek from the viewer\'s seeks', () => {
  it('takes only the first seek after the restore as the swap\'s, wherever the playhead reads by then', () => {
    swap.hooks!.onRestore!(10);
    // The viewer moved to 30 before the restore's seeking event ran, so the element already reads 30 there; then the viewer's own event.
    expect(latest.isRestoreSeek()).toBe(true);
    expect(latest.isRestoreSeek()).toBe(false);
  });

  it('never takes a later viewer seek near the restore point for the swap\'s own', () => {
    swap.hooks!.onRestore!(10);
    // The restore's seeking event and the viewer's own (the viewer moved to 30 meanwhile), then the viewer goes back to 10.02.
    latest.isRestoreSeek();
    expect(latest.isRestoreSeek()).toBe(false);
    expect(latest.isRestoreSeek()).toBe(false);
  });

  it('takes no seek for the swap\'s once the swap ended without its restore being seen', () => {
    swap.hooks!.onRestore!(10);
    swap.hooks!.release();
    expect(latest.isRestoreSeek()).toBe(false);
  });

  it('takes no seek for the swap\'s when no restore is under way', () => {
    expect(latest.isRestoreSeek()).toBe(false);
  });
});

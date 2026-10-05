import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALIGN_TOLERANCE_SECONDS, ERROR_WARNING, MISALIGNED_WARNING, createMediaSwap, drawFreezeFrame, type SwapHooks, type SwapMedia } from '../../web/lib/media-swap';

/** A media element that behaves like a browser's for the parts a source swap touches: a new src resets the playback state and loads again. */
class FakeMedia extends EventTarget implements SwapMedia {
  paused = true;
  playbackRate = 1;
  muted = false;
  volume = 1;
  duration = Number.NaN;
  readyState = 0;
  textTracks = [{ mode: 'disabled' }, { mode: 'hidden' }];
  seeks: number[] = [];
  srcs: string[] = [];
  private position = 0;
  private source = '';
  frameCallbacks: Array<() => void> = [];
  play = vi.fn(() => {
    this.paused = false;
    return Promise.resolve();
  });
  pause = vi.fn(() => {
    this.paused = true;
  });

  constructor(withFrameCallback: boolean) {
    super();
    if (withFrameCallback) {
      this.requestVideoFrameCallback = (cb) => this.frameCallbacks.push(cb);
      this.cancelVideoFrameCallback = vi.fn();
    }
  }
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;

  get src() {
    return this.source;
  }
  set src(value: string) {
    this.source = value;
    this.srcs.push(value);
    this.paused = true;
    this.playbackRate = 1;
    this.position = 0;
    this.duration = Number.NaN;
    this.readyState = 0;
  }
  get currentTime() {
    return this.position;
  }
  set currentTime(value: number) {
    this.seeks.push(value);
    this.position = value;
  }

  /** The element has parsed the new file. */
  loaded(duration: number) {
    this.duration = duration;
    this.readyState = 1;
    this.dispatchEvent(new Event('loadedmetadata'));
  }
  seeked() {
    this.dispatchEvent(new Event('seeked'));
  }
  canPlay() {
    this.readyState = 3;
    this.dispatchEvent(new Event('canplay'));
  }
  failed() {
    this.dispatchEvent(new Event('error'));
  }
  presentFrame() {
    const run = this.frameCallbacks.splice(0);
    for (const cb of run) cb();
  }
}

function setup(withFrameCallback = true) {
  const media = new FakeMedia(withFrameCallback);
  const hooks = { freeze: vi.fn(), release: vi.fn(), warn: vi.fn(), onSource: vi.fn(), pendingSeek: vi.fn<() => number | null>(() => null), onRestore: vi.fn<(time: number) => void>() } satisfies SwapHooks;
  const swap = createMediaSwap(media, hooks);
  return { media, hooks, swap };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('swapping the video source', () => {
  it('freezes the picture, loads the new file and does nothing else until it is parsed', () => {
    const { media, hooks, swap } = setup();
    media.src = 'dark.mp4';
    media.currentTime = 7;
    media.seeks.length = 0;
    swap.swapTo('light.mp4', 'dark.mp4');
    expect(hooks.freeze).toHaveBeenCalledTimes(1);
    expect(media.src).toBe('light.mp4');
    expect(hooks.onSource).toHaveBeenCalledWith('light.mp4');
    expect(media.seeks).toEqual([]);
    expect(hooks.release).not.toHaveBeenCalled();
  });

  it('seeks the new file to the old position and keeps a paused video paused', () => {
    const { media, hooks, swap } = setup();
    media.src = 'dark.mp4';
    media.duration = 60;
    media.currentTime = 12.5;
    media.seeks.length = 0;
    swap.swapTo('light.mp4', 'dark.mp4');
    media.loaded(60);
    expect(media.seeks).toEqual([12.5]);
    media.seeked();
    media.presentFrame();
    expect(media.play).not.toHaveBeenCalled();
    expect(media.paused).toBe(true);
    expect(hooks.release).toHaveBeenCalledTimes(1);
  });

  it('resumes a video that was playing, after the seek and the first frame, not before', () => {
    const { media, hooks, swap } = setup();
    media.src = 'dark.mp4';
    media.duration = 60;
    media.paused = false;
    media.currentTime = 30;
    swap.swapTo('light.mp4', 'dark.mp4');
    media.loaded(60);
    expect(media.play).not.toHaveBeenCalled();
    media.seeked();
    expect(media.play).not.toHaveBeenCalled();
    expect(hooks.release).not.toHaveBeenCalled();
    media.presentFrame();
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(hooks.release).toHaveBeenCalledTimes(1);
  });

  it('restores playback rate, volume, muted and every caption track mode', () => {
    const { media, swap } = setup();
    media.src = 'dark.mp4';
    media.duration = 60;
    media.playbackRate = 1.5;
    media.volume = 0.3;
    media.muted = true;
    media.textTracks[0]!.mode = 'showing';
    media.textTracks[1]!.mode = 'hidden';
    swap.swapTo('light.mp4', 'dark.mp4');
    // The browser resets the rate on load and may reset the tracks.
    media.textTracks[0]!.mode = 'disabled';
    media.loaded(60);
    expect(media.playbackRate).toBe(1.5);
    expect(media.volume).toBe(0.3);
    expect(media.muted).toBe(true);
    expect(media.textTracks.map((t) => t.mode)).toEqual(['showing', 'hidden']);
  });

  it('clamps the position to the length of the new file', () => {
    const { media, swap } = setup();
    media.src = 'dark.mp4';
    media.duration = 60;
    media.currentTime = 59.8;
    media.seeks.length = 0;
    swap.swapTo('light.mp4', 'dark.mp4');
    media.loaded(59.5);
    expect(media.seeks).toEqual([59.5]);
  });

  it('skips the seek at the very start and goes straight to the first frame', () => {
    const { media, hooks, swap } = setup();
    media.src = 'dark.mp4';
    media.duration = 60;
    swap.swapTo('light.mp4', 'dark.mp4');
    media.loaded(60);
    expect(media.seeks).toEqual([]);
    media.presentFrame();
    expect(hooks.release).toHaveBeenCalledTimes(1);
  });

  it('lets a pending Quick guide seek win over the playhead', () => {
    const { media, hooks, swap } = setup();
    media.src = 'dark.mp4';
    media.duration = 60;
    media.currentTime = 2;
    media.seeks.length = 0;
    hooks.pendingSeek.mockReturnValue(41);
    swap.swapTo('light.mp4', 'dark.mp4');
    media.loaded(60);
    expect(media.seeks).toEqual([41]);
  });

  it('uses canplay as the first-frame signal where requestVideoFrameCallback does not exist', () => {
    const { media, hooks, swap } = setup(false);
    media.src = 'dark.mp4';
    media.duration = 60;
    media.paused = false;
    media.currentTime = 9;
    swap.swapTo('light.mp4', 'dark.mp4');
    media.loaded(60);
    media.seeked();
    expect(hooks.release).not.toHaveBeenCalled();
    media.canPlay();
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(hooks.release).toHaveBeenCalledTimes(1);
  });

  it('does not wait for a frame that never comes: the freeze is released after a safety delay', () => {
    const { media, hooks, swap } = setup();
    media.src = 'dark.mp4';
    media.duration = 60;
    media.paused = false;
    media.currentTime = 9;
    swap.swapTo('light.mp4', 'dark.mp4');
    media.loaded(60);
    media.seeked();
    vi.advanceTimersByTime(5000);
    expect(hooks.release).toHaveBeenCalledTimes(1);
    expect(media.play).toHaveBeenCalledTimes(1);
  });

  it('releases once even when the frame and the timer both arrive', () => {
    const { media, hooks, swap } = setup();
    media.src = 'dark.mp4';
    media.duration = 60;
    swap.swapTo('light.mp4', 'dark.mp4');
    media.loaded(60);
    media.presentFrame();
    vi.advanceTimersByTime(5000);
    expect(hooks.release).toHaveBeenCalledTimes(1);
  });

  it('warns when the two files differ in length by more than a second, and not for a smaller gap', () => {
    const near = setup();
    near.media.src = 'dark.mp4';
    near.media.duration = 60;
    near.swap.swapTo('light.mp4', 'dark.mp4');
    near.media.loaded(60 + ALIGN_TOLERANCE_SECONDS);
    expect(near.hooks.warn).not.toHaveBeenCalled();

    const far = setup();
    far.media.src = 'dark.mp4';
    far.media.duration = 60;
    far.swap.swapTo('light.mp4', 'dark.mp4');
    far.media.loaded(62.5);
    expect(far.hooks.warn).toHaveBeenCalledWith(MISALIGNED_WARNING);
    expect(far.media.seeks).toEqual([]);
  });

  it('does not warn about alignment when the old duration was never known', () => {
    const { media, hooks, swap } = setup();
    media.src = 'dark.mp4';
    swap.swapTo('light.mp4', 'dark.mp4');
    media.loaded(60);
    expect(hooks.warn).not.toHaveBeenCalled();
  });
});

describe('a source that fails to load', () => {
  it('reverts to the fallback at the same time, with the same state, and says so', () => {
    const { media, hooks, swap } = setup();
    media.src = 'dark.mp4';
    media.duration = 60;
    media.paused = false;
    media.playbackRate = 2;
    media.currentTime = 21;
    media.seeks.length = 0;
    swap.swapTo('light.mp4', 'dark.mp4');
    media.failed();
    expect(hooks.warn).toHaveBeenCalledWith(ERROR_WARNING);
    expect(media.src).toBe('dark.mp4');
    expect(hooks.onSource).toHaveBeenLastCalledWith('dark.mp4');
    expect(hooks.release).not.toHaveBeenCalled();
    media.loaded(60);
    expect(media.seeks).toEqual([21]);
    expect(media.playbackRate).toBe(2);
    media.seeked();
    media.presentFrame();
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(hooks.release).toHaveBeenCalledTimes(1);
  });

  it('gives up cleanly when the fallback fails too', () => {
    const { media, hooks, swap } = setup();
    media.src = 'dark.mp4';
    media.duration = 60;
    swap.swapTo('light.mp4', 'dark.mp4');
    media.failed();
    media.failed();
    expect(hooks.release).toHaveBeenCalledTimes(1);
    expect(media.srcs).toEqual(['dark.mp4', 'light.mp4', 'dark.mp4']);
  });

  it('gives up when there is no fallback', () => {
    const { media, hooks, swap } = setup();
    media.src = 'a.mp4';
    swap.swapTo('b.mp4', null);
    media.failed();
    expect(hooks.release).toHaveBeenCalledTimes(1);
    expect(hooks.warn).toHaveBeenCalledTimes(1);
    expect(media.srcs).toEqual(['a.mp4', 'b.mp4']);
  });

  it('ignores an error that arrives after the swap finished', () => {
    const { media, hooks, swap } = setup();
    media.src = 'dark.mp4';
    media.duration = 60;
    swap.swapTo('light.mp4', 'dark.mp4');
    media.loaded(60);
    media.presentFrame();
    media.failed();
    expect(hooks.warn).not.toHaveBeenCalled();
    expect(media.src).toBe('light.mp4');
  });
});

describe('swapping again while a swap is under way', () => {
  it('keeps the position the user had, not the reset one the browser reports mid swap', () => {
    const { media, hooks, swap } = setup();
    media.src = 'dark.mp4';
    media.duration = 60;
    media.paused = false;
    media.currentTime = 33;
    media.seeks.length = 0;
    swap.swapTo('light.mp4', 'dark.mp4');
    swap.swapTo('dark.mp4', null);
    expect(hooks.freeze).toHaveBeenCalledTimes(2);
    media.loaded(60);
    expect(media.seeks).toEqual([33]);
    media.seeked();
    media.presentFrame();
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(hooks.release).toHaveBeenCalledTimes(1);
  });

  it('never reacts to the events of the source it replaced', () => {
    const { media, swap } = setup();
    media.src = 'dark.mp4';
    media.duration = 60;
    media.currentTime = 5;
    media.seeks.length = 0;
    swap.swapTo('light.mp4', 'dark.mp4');
    media.loaded(60);
    swap.swapTo('dark.mp4', null);
    media.seeked();
    expect(media.seeks).toEqual([5]);
    media.loaded(60);
    expect(media.seeks).toEqual([5, 5]);
  });
});

describe('a viewer seek during a swap', () => {
  const swapping = () => {
    const ctx = setup();
    ctx.media.src = 'dark.mp4';
    ctx.media.duration = 60;
    ctx.media.currentTime = 12.5;
    ctx.media.seeks.length = 0;
    ctx.swap.swapTo('light.mp4', 'dark.mp4');
    return ctx;
  };

  it('tells the page the time of its own restoring seek just before it makes it, so that seek can be told from the viewer\'s', () => {
    const { media, hooks } = swapping();
    hooks.onRestore.mockImplementation(() => expect(media.seeks).toEqual([]));
    media.loaded(60);
    expect(hooks.onRestore).toHaveBeenCalledWith(12.5);
    expect(media.seeks).toEqual([12.5]);
  });

  it('reports the place it will restore while the new file loads (the element reads 0 then), and nothing once it is parsed', () => {
    const { media, swap } = swapping();
    expect(media.currentTime).toBe(0);
    expect(swap.position()).toBe(12.5);
    media.loaded(60);
    expect(swap.position()).toBeNull();
  });

  it('lets a seek made while the new file loads win: the swap restores to it, not to the old place', () => {
    const { media, hooks, swap } = swapping();
    swap.seekTo(2.5);
    expect(swap.position()).toBe(2.5);
    media.loaded(60);
    expect(media.seeks).toEqual([2.5]);
    expect(hooks.onRestore).toHaveBeenCalledWith(2.5);
  });

  it('keeps that seek through a revert to the fallback', () => {
    const { media, swap } = swapping();
    swap.seekTo(3);
    media.failed();
    media.loaded(60);
    expect(media.seeks).toEqual([3]);
  });

  it('given a seek after the new file is parsed but before the swap ends, when the new file then fails, then the fallback restores the seek', () => {
    const { media, swap } = swapping();
    media.loaded(60);
    swap.seekTo(2.5);
    expect(media.currentTime).toBe(2.5);
    media.failed();
    expect(media.src).toBe('dark.mp4');
    media.loaded(60);
    expect(media.seeks).toEqual([12.5, 2.5, 2.5]);
  });

  it('given a seek after the new file is parsed but before the swap ends, when the theme flips back, then the swap back restores the seek', () => {
    const { media, swap } = swapping();
    media.loaded(60);
    swap.seekTo(2.5);
    swap.swapTo('dark.mp4', null);
    media.loaded(60);
    expect(media.seeks).toEqual([12.5, 2.5, 2.5]);
  });

  it('given a native seek (the scrubber) to 2.5 after the new file is parsed, when the new file then fails, then the fallback restores 2.5', () => {
    const { media, swap } = swapping();
    media.loaded(60);
    // What the page does on the element's seeking event for a seek that is not the swap's own restore.
    media.currentTime = 2.5;
    swap.noteSeek(2.5);
    media.failed();
    media.loaded(60);
    expect(media.seeks).toEqual([12.5, 2.5, 2.5]);
  });

  it('only records a noted seek, never moves the element, and ignores one while the new file loads or with no swap under way', () => {
    const { media, swap } = swapping();
    swap.noteSeek(7);
    expect(swap.position()).toBe(12.5);
    media.loaded(60);
    swap.noteSeek(2.5);
    expect(media.seeks).toEqual([12.5]);
    const idle = setup();
    idle.swap.noteSeek(3);
    expect(idle.media.seeks).toEqual([]);
  });

  it('moves the element itself when no swap is waiting for its file: none under way, or the restore already made', () => {
    const { media, swap } = setup();
    media.src = 'dark.mp4';
    media.duration = 60;
    swap.seekTo(4);
    expect(media.seeks).toEqual([4]);
    swap.swapTo('light.mp4', 'dark.mp4');
    media.loaded(60);
    swap.seekTo(9);
    // 4 by the viewer, 4 again by the swap restoring it in the new file, then 9 by the viewer.
    expect(media.seeks).toEqual([4, 4, 9]);
    expect(swap.position()).toBeNull();
  });
});

describe('dispose', () => {
  it('stops listening, cancels the timer and releases the freeze', () => {
    const { media, hooks, swap } = setup();
    media.src = 'dark.mp4';
    media.duration = 60;
    swap.swapTo('light.mp4', 'dark.mp4');
    swap.dispose();
    expect(hooks.release).toHaveBeenCalledTimes(1);
    media.loaded(60);
    media.failed();
    vi.advanceTimersByTime(5000);
    expect(media.seeks).toEqual([]);
    expect(hooks.warn).not.toHaveBeenCalled();
    expect(hooks.release).toHaveBeenCalledTimes(1);
  });

  it('is harmless when nothing is under way', () => {
    const { hooks, swap } = setup();
    swap.dispose();
    expect(hooks.release).not.toHaveBeenCalled();
  });
});

describe('drawFreezeFrame', () => {
  const canvasStub = () => {
    const drawImage = vi.fn();
    return { canvas: { width: 0, height: 0, getContext: () => ({ drawImage }) } as unknown as HTMLCanvasElement, drawImage };
  };

  it('copies the current frame at the native size', () => {
    const { canvas, drawImage } = canvasStub();
    const video = { readyState: 2, videoWidth: 320, videoHeight: 180 } as HTMLVideoElement;
    expect(drawFreezeFrame(video, canvas)).toBe(true);
    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(180);
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 320, 180);
  });

  it.each([
    ['no frame yet', { readyState: 1, videoWidth: 320, videoHeight: 180 }],
    ['no size yet', { readyState: 2, videoWidth: 0, videoHeight: 0 }],
  ])('returns false with %s', (_label, video) => {
    const { canvas, drawImage } = canvasStub();
    expect(drawFreezeFrame(video as HTMLVideoElement, canvas)).toBe(false);
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('returns false when drawing throws or there is no 2d context', () => {
    const throwing = { width: 0, height: 0, getContext: () => ({ drawImage: () => { throw new Error('tainted'); } }) } as unknown as HTMLCanvasElement;
    const none = { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement;
    const video = { readyState: 4, videoWidth: 10, videoHeight: 10 } as HTMLVideoElement;
    expect(drawFreezeFrame(video, throwing)).toBe(false);
    expect(drawFreezeFrame(video, none)).toBe(false);
  });
});

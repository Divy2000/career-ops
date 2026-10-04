/**
 * Swapping the source of a playing <video> (the dark and the light recording of one tutorial) without the viewer losing their place.
 * The element is never re-created: the controller snapshots its state, points it at the other file, waits until the new file has parsed,
 * seeked and shown a frame, restores the state and only then lets go of the freeze-frame that hid the reload.
 * The element is addressed through the small SwapMedia surface so the logic runs against a fake in unit tests.
 */

export const ALIGN_TOLERANCE_SECONDS = 1;
export const MISALIGNED_WARNING = 'The light and dark videos are not aligned (their lengths differ by more than a second), so the position may be off.';
export const ERROR_WARNING = 'The light video could not be loaded; showing the dark video.';
const GIVE_UP_WARNING = 'The video could not be loaded.';
/** A frame normally follows the seek within a few tens of milliseconds; this only guards against one that never comes. */
const FRAME_TIMEOUT_MS = 1500;

export interface SwapTrack {
  mode: string;
}

export interface SwapMedia extends EventTarget {
  src: string;
  currentTime: number;
  readonly paused: boolean;
  playbackRate: number;
  muted: boolean;
  volume: number;
  readonly duration: number;
  readonly readyState: number;
  readonly textTracks: ArrayLike<SwapTrack>;
  play(): Promise<void> | void;
  pause(): void;
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

export interface SwapHooks {
  /** Cover the video with its current frame. May do nothing when no frame can be read. */
  freeze(): void;
  /** Fade the cover away. Called exactly once per swap, however it ends. */
  release(): void;
  warn(message: string): void;
  /** The src the element now carries (after a revert it is the fallback). */
  onSource(src: string): void;
  /** A seek the page still has to apply (the Quick guide's "Watch in video"); it beats the playhead. */
  pendingSeek?(): number | null;
}

interface Snapshot {
  time: number;
  playing: boolean;
  rate: number;
  muted: boolean;
  volume: number;
  modes: string[];
  duration: number;
}

export interface MediaSwap {
  /** Load `src`; if it fails, load `fallback` (null: give up). A swap under way keeps its original snapshot. */
  swapTo(src: string, fallback: string | null): void;
  dispose(): void;
}

export function createMediaSwap(media: SwapMedia, hooks: SwapHooks): MediaSwap {
  let snapshot: Snapshot | null = null;
  let stop: (() => void) | null = null;

  const take = (): Snapshot => ({
    time: hooks.pendingSeek?.() ?? media.currentTime,
    playing: !media.paused,
    rate: media.playbackRate,
    muted: media.muted,
    volume: media.volume,
    modes: Array.from(media.textTracks, (t) => t.mode),
    duration: media.duration,
  });

  const restoreSettings = (s: Snapshot) => {
    media.playbackRate = s.rate;
    media.muted = s.muted;
    media.volume = s.volume;
    s.modes.forEach((mode, i) => {
      const track = media.textTracks[i];
      if (track) track.mode = mode;
    });
  };

  const end = () => {
    stop?.();
    stop = null;
    snapshot = null;
  };

  const load = (src: string, fallback: string | null, s: Snapshot) => {
    stop?.();
    const cleanups: Array<() => void> = [];
    const listen = (type: string, handler: () => void) => {
      media.addEventListener(type, handler, { once: true });
      cleanups.push(() => media.removeEventListener(type, handler));
    };
    let frameHandle: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const teardown = () => {
      for (const c of cleanups.splice(0)) c();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (frameHandle !== null) media.cancelVideoFrameCallback?.(frameHandle);
      frameHandle = null;
    };
    stop = teardown;

    const finish = () => {
      teardown();
      if (s.playing) void Promise.resolve(media.play()).catch(() => undefined);
      hooks.release();
      end();
    };

    const onError = () => {
      teardown();
      if (fallback === null) {
        hooks.warn(GIVE_UP_WARNING);
        hooks.release();
        end();
        return;
      }
      hooks.warn(ERROR_WARNING);
      load(fallback, null, s);
    };

    const awaitFrame = () => {
      timer = setTimeout(finish, FRAME_TIMEOUT_MS);
      if (media.requestVideoFrameCallback) frameHandle = media.requestVideoFrameCallback(finish);
      else if (media.readyState >= 3) finish();
      else listen('canplay', finish);
    };

    const onMetadata = () => {
      if (Number.isFinite(s.duration) && Math.abs(media.duration - s.duration) > ALIGN_TOLERANCE_SECONDS) hooks.warn(MISALIGNED_WARNING);
      restoreSettings(s);
      const target = Number.isFinite(media.duration) ? Math.min(s.time, media.duration) : s.time;
      cleanups.splice(0).forEach((c) => c());
      listen('error', onError);
      if (target > 0) {
        listen('seeked', awaitFrame);
        media.currentTime = target;
      } else awaitFrame();
    };

    listen('loadedmetadata', onMetadata);
    listen('error', onError);
    media.src = src;
    hooks.onSource(src);
  };

  return {
    swapTo(src, fallback) {
      snapshot ??= take();
      hooks.freeze();
      load(src, fallback, snapshot);
    },
    dispose() {
      if (!stop) return;
      end();
      hooks.release();
    },
  };
}

/** Copies the frame a video is showing onto `canvas` at its native size. False when there is no frame to copy (or the browser refuses). */
export function drawFreezeFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): boolean {
  if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return false;
  try {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
    return true;
  } catch {
    return false;
  }
}

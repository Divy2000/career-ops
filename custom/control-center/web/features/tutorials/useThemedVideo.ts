import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createMediaSwap, drawFreezeFrame, type MediaSwap } from '../../lib/media-swap';
import { useTheme } from '../../lib/theme';
import type { TutorialPart } from '@shared/api';

/**
 * Which recording of a part the <video> carries, decided by the resolved theme (dark when there is no light one), and the swap between
 * them when the theme changes. The element is never re-created: its src is only ever set here, imperatively, after the first render.
 */
export function useThemedVideo(video: RefObject<HTMLVideoElement | null>, cover: RefObject<HTMLCanvasElement | null>, part: TutorialPart, pendingSeek: number | null) {
  const { resolved } = useTheme();
  const dark = part.video.url;
  const wanted = resolved === 'light' && part.videoLight ? part.videoLight.url : dark;
  const [initialSrc] = useState(wanted);
  const shown = useRef(initialSrc);
  const swap = useRef<MediaSwap | null>(null);
  const pending = useRef(pendingSeek);
  /** The time of the swap's own restoring seek until its `seeking` event is seen: that one seek is not the viewer's. */
  const restoreAt = useRef<number | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    pending.current = pendingSeek;
  });

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const controller = createMediaSwap(el, {
      freeze: () => {
        setWarning(null);
        const canvas = cover.current;
        if (canvas && drawFreezeFrame(el, canvas)) canvas.dataset.state = 'on';
      },
      release: () => {
        restoreAt.current = null;
        if (cover.current) cover.current.dataset.state = 'off';
      },
      warn: setWarning,
      onSource: (src) => {
        shown.current = src;
      },
      pendingSeek: () => pending.current,
      onRestore: (time) => {
        restoreAt.current = time;
      },
    });
    swap.current = controller;
    return () => {
      controller.dispose();
      swap.current = null;
    };
  }, [video, cover]);

  useEffect(() => {
    if (wanted !== shown.current) swap.current?.swapTo(wanted, wanted === dark ? null : dark);
    // Already showing what the theme wants (a failed light file left the dark one up and the theme went back to dark): no notice applies.
    else setWarning(null);
  }, [wanted, dark]);

  /** While a swap waits for the new file (the element reads 0 then), the place it will restore; otherwise null, and the element's time holds. */
  const position = useCallback(() => swap.current?.position() ?? null, []);
  /** A seek by the viewer, through the swap controller (it exists whenever the element does): during a swap it replaces the place the swap restores. */
  const seek = useCallback((time: number) => swap.current?.seekTo(time), []);
  /** A seek the element made that is not the swap's restore (the native scrubber included): a swap under way keeps it as the place. */
  const noteSeek = useCallback((time: number) => swap.current?.noteSeek(time), []);
  /** True once, for the `seeking` event of the swap's own restoring seek; any other seek is the viewer's. */
  const isRestoreSeek = useCallback((time: number) => {
    if (restoreAt.current === null || Math.abs(time - restoreAt.current) > 0.05) return false;
    restoreAt.current = null;
    return true;
  }, []);

  return {
    initialSrc,
    position,
    seek,
    noteSeek,
    isRestoreSeek,
    warning,
    poster: (resolved === 'light' && part.posterLight ? part.posterLight : part.poster)?.url,
    lightMissing: resolved === 'light' && part.videoLight === null,
  };
}

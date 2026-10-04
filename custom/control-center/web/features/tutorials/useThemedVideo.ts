import { useEffect, useRef, useState, type RefObject } from 'react';
import { createMediaSwap, drawFreezeFrame, type MediaSwap } from '../../lib/media-swap';
import { useTheme } from '../../lib/theme';
import type { Tutorial } from '@shared/api';

/**
 * Which recording the <video> carries, decided by the resolved theme (dark when there is no light one), and the swap between
 * them when the theme changes. The element is never re-created: its src is only ever set here, imperatively, after the first render.
 */
export function useThemedVideo(video: RefObject<HTMLVideoElement | null>, cover: RefObject<HTMLCanvasElement | null>, tutorial: Tutorial, pendingSeek: number | null) {
  const { resolved } = useTheme();
  const dark = tutorial.video.url;
  const wanted = resolved === 'light' && tutorial.videoLight ? tutorial.videoLight.url : dark;
  const [initialSrc] = useState(wanted);
  const shown = useRef(initialSrc);
  const swap = useRef<MediaSwap | null>(null);
  const pending = useRef(pendingSeek);
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
        if (cover.current) cover.current.dataset.state = 'off';
      },
      warn: setWarning,
      onSource: (src) => {
        shown.current = src;
      },
      pendingSeek: () => pending.current,
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

  return {
    initialSrc,
    warning,
    poster: (resolved === 'light' && tutorial.posterLight ? tutorial.posterLight : tutorial.poster)?.url,
    lightMissing: resolved === 'light' && tutorial.videoLight === null,
  };
}

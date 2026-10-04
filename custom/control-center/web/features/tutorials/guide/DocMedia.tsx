import * as Dialog from '@radix-ui/react-dialog';
import { Maximize2, Pause, Play, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { usePrefersReducedMotion } from '../../../lib/reduced-motion';
import { useTheme } from '../../../lib/theme';
import type { GuideBlockView } from '@shared/api';

type MediaBlock = Extract<GuideBlockView, { type: 'media' }>;

/** An adapted legacy guide does not declare a size; its clips were recorded at this ratio. */
const FALLBACK_RATIO = '16 / 9';
/** If the enter animation never reports back (reduced motion switches animations off), the old layer is dropped after this. */
const OUTGOING_FALLBACK_MS = 600;

/** The frame an animated image is showing right now, as a still image; null when it cannot be read. */
function stillOf(img: HTMLImageElement): string | null {
  if (!img.complete || img.naturalWidth === 0) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d')?.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/**
 * The image shown for `target`. When `target` changes after the current image has painted, the new one is decoded off-screen first
 * and then fades in over the old one, so a theme change or a poster-to-clip switch never flashes an unpainted frame.
 * If the current image has not loaded yet (it is lazy and far down the page) the new one simply replaces it.
 */
function useCrossfade(target: string) {
  const [shown, setShown] = useState<{ url: string; from: string | null }>({ url: target, from: null });
  const [ready, setReady] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    if (target === shown.url) return;
    let cancelled = false;
    const next = new Image();
    next.src = target;
    const settle = () => {
      if (!cancelled) setShown((s) => ({ url: target, from: loaded.current ? s.url : null }));
    };
    // decode() resolves once the image can be painted without a flash. A failure keeps the current image, which is better than a broken one.
    const decoded = loaded.current && typeof next.decode === 'function' ? next.decode() : Promise.resolve();
    void decoded.then(settle, () => undefined);
    return () => {
      cancelled = true;
    };
  }, [target, shown.url]);

  useEffect(() => {
    if (shown.from === null) return;
    const timer = setTimeout(() => setShown((s) => ({ ...s, from: null })), OUTGOING_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [shown.from]);

  const onLoad = useCallback(() => {
    loaded.current = true;
    setReady(true);
  }, []);
  const dropOutgoing = useCallback(() => setShown((s) => (s.from === null ? s : { ...s, from: null })), []);
  return { url: shown.url, from: shown.from, ready, onLoad, dropOutgoing };
}

function Layers({ fade, className }: { fade: ReturnType<typeof useCrossfade>; className?: string }) {
  return (
    <>
      {fade.from !== null && <img className={`doc-media__img doc-media__img--from ${className ?? ''}`} src={fade.from} alt="" aria-hidden="true" />}
      <img key={fade.url} className={`doc-media__img doc-media__img--top ${fade.from !== null ? 'doc-media__img--enter' : ''} ${className ?? ''}`} src={fade.url} alt="" loading="lazy" decoding="async" onLoad={fade.onLoad} onAnimationEnd={fade.dropOutgoing} />
    </>
  );
}

/** The dialog content; the opener is a Dialog.Trigger in the figure, which is what lets Radix hand focus back to it on close. */
function Lightbox({ url, block }: { url: string; block: MediaBlock }) {
  return (
    <Dialog.Portal>
      <Dialog.Overlay className="dialog__overlay" />
      <Dialog.Content className="dialog guide-lightbox" aria-describedby={block.caption ? 'guide-lightbox-caption' : undefined}>
        <Dialog.Title className="sr-only">{block.alt}</Dialog.Title>
        <Dialog.Close asChild>
          <button type="button" className="guide-lightbox__close" aria-label="Close">
            <X size={18} aria-hidden="true" />
          </button>
        </Dialog.Close>
        <img className="guide-lightbox__img" src={url} alt={block.alt} width={block.width ?? undefined} height={block.height ?? undefined} />
        {block.caption && (
          <Dialog.Description id="guide-lightbox-caption" className="guide-lightbox__caption">
            {block.caption}
          </Dialog.Description>
        )}
      </Dialog.Content>
    </Dialog.Portal>
  );
}

/**
 * A figure in the guide: the frame has the declared aspect ratio before anything loads, so nothing moves when the image arrives.
 * An image follows the theme and opens in a lightbox; a clip shows its poster until half of it is on screen, then plays, and a click pauses it.
 */
export function DocMedia({ block }: { block: MediaBlock }) {
  const { resolved } = useTheme();
  const reducedMotion = usePrefersReducedMotion();
  const isClip = block.kind === 'gif';
  const pick = (dark: string | null, light: string | null) => (resolved === 'light' && light !== null ? light : dark);
  const animated = pick(block.url, block.urlLight) ?? block.url;
  const poster = pick(block.posterUrl, block.posterLightUrl);

  const frame = useRef<HTMLDivElement>(null);
  const [started, setStarted] = useState(false);
  const [mode, setMode] = useState<'auto' | 'play' | 'pause'>('auto');
  const [still, setStill] = useState<string | null>(null);
  const [stillFailed, setStillFailed] = useState(false);

  useEffect(() => {
    const el = frame.current;
    if (!isClip || !el || started || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setStarted(true);
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [isClip, started]);

  const playing = isClip && (mode === 'play' || (mode === 'auto' && started && !reducedMotion));
  // A clip without a poster (an adapted legacy guide) pauses on a captured frame instead.
  const capturing = isClip && !playing && poster === null && still === null && !stillFailed;
  const visual = !isClip || playing ? animated : (poster ?? still ?? animated);
  const fade = useCrossfade(visual);

  const toggle = () => {
    if (playing) {
      if (poster === null) {
        const top = frame.current?.querySelector<HTMLImageElement>('.doc-media__img--top');
        const frameNow = top ? stillOf(top) : null;
        if (frameNow === null) return;
        setStill(frameNow);
      }
      setMode('pause');
    } else setMode('play');
  };

  const style = { '--ar': block.width !== null && block.height !== null ? `${block.width} / ${block.height}` : FALLBACK_RATIO, '--w': block.width !== null ? `${block.width}px` : '100%' } as CSSProperties;
  const label = block.alt;

  return (
    <figure className="doc-media" style={style}>
      <Dialog.Root>
        <div ref={frame} className="doc-media__frame" data-ready={fade.ready ? 'true' : 'false'} data-playing={playing ? 'true' : 'false'}>
          {isClip ? (
            <>
              <button type="button" className="doc-media__hit" aria-label={`${playing ? 'Pause' : 'Play'} animation: ${label}`} onClick={toggle}>
                <Layers fade={fade} className={capturing ? 'doc-media__img--capturing' : undefined} />
                {capturing && <CaptureStill src={animated} onStill={(s) => (s === null ? setStillFailed(true) : setStill(s))} />}
                <span className="doc-media__state" aria-hidden="true">
                  {playing ? <Pause size={14} /> : <Play size={26} />}
                </span>
              </button>
              <Dialog.Trigger asChild>
                <button type="button" className="doc-media__expand" aria-label={`View larger: ${label}`}>
                  <Maximize2 size={14} aria-hidden="true" />
                </button>
              </Dialog.Trigger>
            </>
          ) : (
            <>
              <Dialog.Trigger asChild>
                <button type="button" className="doc-media__hit doc-media__hit--zoom" aria-label={`View larger: ${label}`}>
                  <Layers fade={fade} />
                </button>
              </Dialog.Trigger>
              <span className="doc-media__expand" aria-hidden="true">
                <Maximize2 size={14} />
              </span>
            </>
          )}
        </div>
        <Lightbox url={isClip ? animated : fade.url} block={block} />
      </Dialog.Root>
      {block.caption && <figcaption className="doc-media__caption">{block.caption}</figcaption>}
    </figure>
  );
}

/** Loads the clip once, off-screen, to take its first frame as the paused picture. */
function CaptureStill({ src, onStill }: { src: string; onStill: (still: string | null) => void }) {
  return <img className="doc-media__capture" src={src} alt="" aria-hidden="true" onLoad={(e) => onStill(stillOf(e.currentTarget))} onError={() => onStill(null)} />;
}

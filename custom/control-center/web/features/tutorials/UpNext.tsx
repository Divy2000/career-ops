import { Play, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '../../lib/reduced-motion';

const COUNTDOWN_SECONDS = 8;

interface Props {
  next: { title: string };
  /** The next part's number, from 1. */
  number: number;
  total: number;
  onPlay: () => void;
  onCancel: () => void;
}

/**
 * Shown over the stage when a part ends: the next part starts after a countdown unless the viewer cancels (Escape works too).
 * It never takes focus; a polite live region says once what comes next, and the ticking seconds stay out of it.
 */
export function UpNext({ next, number, total, onPlay, onCancel }: Props) {
  const reduced = usePrefersReducedMotion();
  const [left, setLeft] = useState(COUNTDOWN_SECONDS);
  const latest = useRef({ onPlay, onCancel });
  useEffect(() => {
    latest.current = { onPlay, onCancel };
  });

  useEffect(() => {
    const timer = setInterval(() => setLeft((s) => s - 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const played = useRef(false);
  useEffect(() => {
    if (left > 0 || played.current) return;
    played.current = true;
    latest.current.onPlay();
  }, [left]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      latest.current.onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const playNow = () => {
    if (played.current) return;
    played.current = true;
    onPlay();
  };

  return (
    <div className="tut-upnext" role="group" aria-labelledby="tut-upnext-title">
      <div className="tut-upnext__card">
        <p className="tut-upnext__eyebrow" id="tut-upnext-title">
          Up next <span aria-hidden="true">·</span> Part {number} of {total}
        </p>
        <p className="tut-upnext__name">{next.title}</p>
        {!reduced && (
          <span className="tut-upnext__track" aria-hidden="true">
            <span className="tut-upnext__bar" style={{ animationDuration: `${COUNTDOWN_SECONDS}s` }} />
          </span>
        )}
        <div className="tut-upnext__actions">
          <span className="tut-upnext__count">Playing in {Math.max(left, 0)} s</span>
          <button type="button" className="tut-upnext__cancel" onClick={onCancel}>
            <X size={14} aria-hidden="true" /> Cancel
          </button>
          <button type="button" className="tut-upnext__play" onClick={playNow}>
            <Play size={14} aria-hidden="true" /> Play now
          </button>
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        Up next: part {number} of {total}, {next.title}. Playing in {COUNTDOWN_SECONDS} seconds.
      </p>
    </div>
  );
}

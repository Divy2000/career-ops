import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { countReviewed, filterSections, guideKeyAction, readReviewed, stepSection, writeReviewed } from '../../lib/guide';
import type { KeyTarget } from '../../lib/tutorials';
import type { GuideSectionView, TutorialGuide } from '@shared/api';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => (typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_MOTION).matches : false));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(REDUCED_MOTION);
    const sync = () => setReduced(query.matches);
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return reduced;
}

function targetKind(el: EventTarget | null): KeyTarget {
  if (!(el instanceof HTMLElement)) return 'body';
  if (el.isContentEditable) return 'editable';
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return tag;
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'a') return 'link';
  return 'body';
}

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
 * The section animation. A click pauses it: on the poster when the section has one, otherwise on the frame it was showing.
 * With reduced motion it starts paused, behind a play button.
 */
function GuideMedia({ section }: { section: GuideSectionView }) {
  const reducedMotion = usePrefersReducedMotion();
  const [playing, setPlaying] = useState(!reducedMotion);
  const [still, setStill] = useState<string | null>(null);
  const [stillFailed, setStillFailed] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  const poster = section.poster?.url ?? null;
  const needsStill = !playing && poster === null && still === null && !stillFailed;

  const toggle = () => {
    if (!playing) {
      setPlaying(true);
      return;
    }
    if (poster === null) {
      const frame = img.current ? stillOf(img.current) : null;
      if (frame === null) return;
      setStill(frame);
    }
    setPlaying(false);
  };

  const src = playing ? section.gif.url : (poster ?? still ?? section.gif.url);
  return (
    <button type="button" className="guide__media" aria-label={playing ? 'Pause animation' : 'Play animation'} onClick={toggle}>
      <img
        ref={img}
        className={needsStill ? 'guide__img guide__img--pending' : 'guide__img'}
        src={src}
        alt={`${section.title}: animated walkthrough`}
        loading="lazy"
        decoding="async"
        onLoad={
          needsStill
            ? (e) => {
                const frame = stillOf(e.currentTarget);
                if (frame === null) setStillFailed(true);
                else setStill(frame);
              }
            : undefined
        }
      />
      {!playing && (
        <span className="guide__play" aria-hidden="true">
          <span className="guide__play-icon" />
        </span>
      )}
    </button>
  );
}

interface Props {
  tutorialId: string;
  guide: TutorialGuide;
  chapters: Array<{ title: string; start: number }>;
  /** The section id from the URL; an unknown or missing one means the first section. */
  sectionId: string | undefined;
  onSelect: (id: string, replace: boolean) => void;
  onWatch: (start: number) => void;
}

export function QuickGuide({ tutorialId, guide, chapters, sectionId, onSelect, onWatch }: Props) {
  const router = useRouter();
  const { sections } = guide;
  const [term, setTerm] = useState('');
  const [reviewed, setReviewed] = useState(() => new Set(readReviewed(tutorialId)));
  const selected = sections.find((s) => s.id === sectionId) ?? sections[0]!;
  const visible = useMemo(() => filterSections(sections, term), [sections, term]);
  const done = countReviewed(sections, reviewed);
  const list = useRef<HTMLUListElement>(null);
  const keyMove = useRef<{ focus: boolean } | null>(null);

  const setMarks = (next: Set<string>) => {
    setReviewed(next);
    writeReviewed(tutorialId, Array.from(next));
  };
  const toggleReviewed = (id: string) => {
    const next = new Set(reviewed);
    if (!next.delete(id)) next.add(id);
    setMarks(next);
  };

  // The search keeps the shown section among the matches, so the list, the select and the content never disagree.
  const search = (value: string) => {
    setTerm(value);
    const matches = filterSections(sections, value);
    if (matches.length > 0 && !matches.some((s) => s.id === selected.id)) onSelect(matches[0]!.id, true);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = guideKeyAction({ key: e.key, target: targetKind(e.target), ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey });
      if (!action) return;
      const next = stepSection(visible, selected.id, action === 'next' ? 1 : -1);
      if (next === null) return;
      e.preventDefault();
      keyMove.current = { focus: list.current?.contains(document.activeElement) === true };
      onSelect(next, true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, selected.id, onSelect]);

  useEffect(() => {
    const move = keyMove.current;
    keyMove.current = null;
    if (!move) return;
    const item = list.current?.querySelector<HTMLElement>(`[data-section="${CSS.escape(selected.id)}"]`);
    if (!item) return;
    item.scrollIntoView({ block: 'nearest' });
    if (move.focus) item.focus({ preventScroll: true });
  }, [selected.id]);

  const at = visible.findIndex((s) => s.id === selected.id);
  const prev = at > 0 ? visible[at - 1]! : null;
  const next = at >= 0 && at < visible.length - 1 ? visible[at + 1]! : null;
  const chapter = selected.chapter === null ? undefined : chapters[selected.chapter];
  const isDone = reviewed.has(selected.id);
  const route = selected.route;

  return (
    <section className="guide" aria-label="Quick guide">
      <aside className="guide__nav">
        <div className="guide__progress">
          <div className="row gap" style={{ justifyContent: 'space-between' }}>
            <p role="status" className="small guide__count">
              <strong>{done} of {sections.length}</strong> reviewed
            </p>
            <button type="button" className="small" aria-label="Reset progress" disabled={done === 0} onClick={() => setMarks(new Set())}>
              Reset
            </button>
          </div>
          <div className="bar__track" role="progressbar" aria-label="Sections reviewed" aria-valuemin={0} aria-valuemax={sections.length} aria-valuenow={done}>
            <span className="bar__fill" style={{ width: `${(done / sections.length) * 100}%` }} />
          </div>
        </div>
        <input type="search" aria-label="Search the guide" placeholder="Search the guide" value={term} onChange={(e) => search(e.target.value)} />
        <select className="guide__select" aria-label="Section" value={selected.id} disabled={visible.length === 0} onChange={(e) => onSelect(e.target.value, false)}>
          {visible.map((s) => (
            <option key={s.id} value={s.id}>
              {reviewed.has(s.id) ? `${s.title} (reviewed)` : s.title}
            </option>
          ))}
        </select>
        <nav aria-label="Guide sections" className="guide__list">
          {visible.length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>
              No sections match "{term.trim()}".
            </p>
          ) : (
            <ul ref={list}>
              {visible.map((s) => {
                const active = s.id === selected.id;
                const marked = reviewed.has(s.id);
                return (
                  <li key={s.id}>
                    <button type="button" data-section={s.id} className={`guide__item ${active ? 'guide__item--active' : ''}`} aria-current={active ? 'true' : undefined} onClick={() => onSelect(s.id, false)}>
                      <span className={`guide__check ${marked ? 'guide__check--on' : ''}`} aria-hidden="true">
                        {marked ? '✓' : ''}
                      </span>
                      <span className="guide__item-title">{s.title}</span>
                      {marked && <span className="sr-only">, reviewed</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>
        <p className="faint small guide__keys">
          <kbd>J</kbd> and <kbd>K</kbd> or <kbd>Up</kbd> and <kbd>Down</kbd> move between sections
        </p>
      </aside>

      <article className="guide__main" aria-labelledby="guide-title">
        <div className="guide__head">
          <h2 id="guide-title">{selected.title}</h2>
          <button type="button" className={`guide__mark ${isDone ? 'guide__mark--on' : ''}`} aria-pressed={isDone} onClick={() => toggleReviewed(selected.id)}>
            <span aria-hidden="true">{isDone ? '✓' : '○'}</span> Mark reviewed
          </button>
        </div>
        <p className="guide__summary">{selected.summary}</p>
        <GuideMedia key={selected.id} section={selected} />
        <div className="guide__body">
          <div className="stack">
            <h3>Steps</h3>
            <ol className="guide__steps">
              {selected.steps.map((step, i) => (
                <li key={`${i}-${step}`}>{step}</li>
              ))}
            </ol>
          </div>
          {selected.tips.length > 0 && (
            <div className="stack">
              <h3>Tips</h3>
              <ul className="guide__tips">
                {selected.tips.map((tip, i) => (
                  <li key={`${i}-${tip}`}>{tip}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {(route !== null || chapter !== undefined) && (
          <div className="row gap guide__actions">
            {route !== null && (
              <a
                className="button-link guide__primary"
                href={route}
                onClick={(e) => {
                  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  router.history.push(route);
                }}
              >
                Open this page <span aria-hidden="true">→</span>
              </a>
            )}
            {chapter !== undefined && (
              <button type="button" onClick={() => onWatch(chapter.start)}>
                <span aria-hidden="true">▶</span> Watch this part
              </button>
            )}
          </div>
        )}
        <div className="guide__pager">
          <button type="button" disabled={prev === null} onClick={() => prev && onSelect(prev.id, false)}>
            <span aria-hidden="true">←</span> Previous{prev ? `: ${prev.title}` : ''}
          </button>
          <button type="button" disabled={next === null} onClick={() => next && onSelect(next.id, false)}>
            Next{next ? `: ${next.title}` : ''} <span aria-hidden="true">→</span>
          </button>
        </div>
      </article>
    </section>
  );
}

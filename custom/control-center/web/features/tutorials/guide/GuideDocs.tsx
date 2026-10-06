import { useRouter } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Check, ExternalLink, Lightbulb, Play, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import {
  guideKeyAction,
  isSearching,
  loadReviewed,
  resolveLocation,
  sectionProgress,
  spyInitial,
  spyReduce,
  stepSubsection,
  subKey,
  totalProgress,
  writeReviewed,
  type GuideLocation,
  type GuideSearchParams,
  type SpyEntry,
} from '../../../lib/guide';
import { usePrefersReducedMotion } from '../../../lib/reduced-motion';
import type { KeyTarget } from '../../../lib/tutorials';
import type { GuideBlockView, GuideDocs, GuideDocsSectionView, GuideSubsectionView } from '@shared/api';
import { DocMedia } from './DocMedia';
import { GuideContentsSelect, GuideToc } from './GuideToc';
import { GuideSearchBox, GuideSearchResults } from './GuideSearch';

/** The reading band is the top 40% of the scroll area: the heading inside it (or the last one above it) is the one being read. */
const READING_BAND = 0.4;
const SPY_MARGIN = `0px 0px -${(1 - READING_BAND) * 100}% 0px`;
/** Scroll events from a jump the reader asked for must not rewrite the place they asked for. */
const SMOOTH_LOCK_MS = 900;
const INSTANT_LOCK_MS = 150;
const SPY_DEBOUNCE_MS = 160;
/** A scroll this soon after the reader's wheel, touch, scrollbar or scroll key is the reader's. */
const READER_SCROLL_MS = 1000;
/** Keys that scroll the page when nothing that takes them has focus. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
/** Without scrollend, a smooth jump has come to rest once its scroll events stop for this long. */
const SCROLL_IDLE_MS = 150;
const HAS_SCROLLEND = typeof window !== 'undefined' && 'onscrollend' in window;
const OPEN_DIALOG = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

function targetKind(el: EventTarget | null): KeyTarget {
  if (!(el instanceof HTMLElement)) return 'body';
  if (el.isContentEditable) return 'editable';
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return tag;
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'a') return 'link';
  return 'body';
}

const isPlainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
const keyOf = (loc: GuideLocation) => `${loc.sectionId}/${loc.subId ?? ''}`;
const scrollerOf = () => document.querySelector<HTMLElement>('.shell__main') ?? document.documentElement;

function Block({ block }: { block: GuideBlockView }) {
  switch (block.type) {
    case 'text':
      return <p className="guide-text">{block.text}</p>;
    case 'steps':
      return (
        <ol className="guide-steps" aria-label="Steps">
          {block.items.map((item, i) => (
            <li key={`${i}-${item}`}>{item}</li>
          ))}
        </ol>
      );
    case 'tips':
      return (
        <div className="guide-tips" role="note" aria-label={block.items.length === 1 ? 'Tip' : 'Tips'}>
          <p className="guide-tips__label">
            <Lightbulb size={14} aria-hidden="true" /> {block.items.length === 1 ? 'Tip' : 'Tips'}
          </p>
          <ul>
            {block.items.map((item, i) => (
              <li key={`${i}-${item}`}>{item}</li>
            ))}
          </ul>
        </div>
      );
    case 'media':
      return <DocMedia block={block} />;
  }
}

interface SubsectionProps {
  section: GuideDocsSectionView;
  sub: GuideSubsectionView;
  index: number;
  reviewed: boolean;
  chapters: Array<{ title: string; start: number }>;
  onToggle: () => void;
  onWatch: (chapter: number) => void;
}

function Subsection({ section, sub, index, reviewed, chapters, onToggle, onWatch }: SubsectionProps) {
  const router = useRouter();
  const chapter = sub.chapter === null ? undefined : chapters[sub.chapter];
  const headingId = `guide-sub-${sub.id}`;
  return (
    <section className="guide-sub" aria-labelledby={headingId} style={{ '--i': Math.min(index, 4) } as CSSProperties}>
      <h3 id={headingId} data-sub={sub.id} data-section={section.id}>
        {sub.title}
      </h3>
      {sub.summary && <p className="guide-sub__summary">{sub.summary}</p>}
      <div className="guide-sub__body">
        {sub.blocks.map((block, i) => (
          <Block key={i} block={block} />
        ))}
      </div>
      <div className="guide-sub__actions">
        {sub.route !== null && (
          <a
            className="button-link guide-action guide-action--primary"
            href={sub.route}
            onClick={(e) => {
              if (e.defaultPrevented || !isPlainClick(e)) return;
              e.preventDefault();
              router.history.push(sub.route!);
            }}
          >
            Open this page <ExternalLink size={14} aria-hidden="true" />
          </a>
        )}
        {chapter !== undefined && sub.chapter !== null && (
          <button type="button" className="guide-action" onClick={() => onWatch(sub.chapter!)}>
            <Play size={14} aria-hidden="true" /> Watch in video
          </button>
        )}
        <button type="button" className={`guide-action guide-action--mark ${reviewed ? 'guide-action--on' : ''}`} aria-pressed={reviewed} onClick={onToggle}>
          <Check size={14} strokeWidth={reviewed ? 3 : 2} aria-hidden="true" /> Mark reviewed
        </button>
      </div>
    </section>
  );
}

interface Props {
  tutorialId: string;
  docs: GuideDocs;
  chapters: Array<{ title: string; start: number }>;
  /** `?section=` and `?sub=` from the URL; unknown or missing values resolve to the nearest place that exists. */
  section: string | undefined;
  sub: string | undefined;
  searchFor: (loc: GuideLocation) => GuideSearchParams;
  onNavigate: (loc: GuideLocation, replace: boolean) => void;
  /** Called with the subsection's chapter number, counted across every part of the tutorial. */
  onWatch: (chapter: number) => void;
}

export function GuideDocs({ tutorialId, docs, chapters, section, sub, searchFor, onNavigate, onWatch }: Props) {
  const router = useRouter();
  const reducedMotion = usePrefersReducedMotion();
  const hrefFor = useCallback((target: GuideLocation) => router.buildLocation({ to: '/tutorials', search: searchFor(target) }).href, [router, searchFor]);
  const loc = useMemo(() => resolveLocation(docs, section, sub), [docs, section, sub]);
  const locKey = keyOf(loc);
  const sectionIndex = Math.max(
    0,
    docs.sections.findIndex((s) => s.id === loc.sectionId),
  );
  const current = docs.sections[sectionIndex]!;
  const prev = docs.sections[sectionIndex - 1];
  const next = docs.sections[sectionIndex + 1];

  const [reviewed, setReviewed] = useState(() => loadReviewed(tutorialId, docs));
  const [term, setTerm] = useState('');
  const searching = isSearching(term);
  const progress = totalProgress(docs, reviewed);
  const searchInput = useRef<HTMLInputElement>(null);
  const article = useRef<HTMLElement>(null);

  const setMarks = (marks: Set<string>) => {
    setReviewed(marks);
    writeReviewed(tutorialId, Array.from(marks));
  };
  const toggleReviewed = (key: string) => {
    const marks = new Set(reviewed);
    if (!marks.delete(key)) marks.add(key);
    setMarks(marks);
  };

  // What the effects below read must be the latest render's, without re-running them.
  const latest = useRef({ loc, locKey, onNavigate });
  useEffect(() => {
    latest.current = { loc, locKey, onNavigate };
  });

  // Scrolling: a place the reader asked for is scrolled to once; a place the scroll-spy wrote into the URL is already in view.
  const [scrollTick, setScrollTick] = useState(0);
  const handled = useRef({ key: '', tick: 0, section: '' });
  const spyWrote = useRef<string | null>(null);
  const lockUntil = useRef(0);
  // A subsection the reader asked for stays the current one until the reader scrolls the page, or the page moves off where the jump left it.
  // `at` is that resting scroll position: an instant jump knows it at once, a smooth one when its scroll ends (scrollend, or
  // scroll events going quiet where there is no scrollend). `moved` says the smooth one has scrolled at all: one that had
  // nowhere to go fires nothing, so it rests wherever the page is when its lock runs out.
  const pinned = useRef<{ at: number | null; moved: boolean } | null>(null);
  // When the reader last used the wheel, a touch, the scrollbar or a scroll key: a scroll right after that is theirs, not the jump's.
  const readerInputAt = useRef(Number.NEGATIVE_INFINITY);
  const restTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(restTimer.current), []);

  const goTo = useCallback(
    (target: GuideLocation, replace = false) => {
      setTerm('');
      if (keyOf(target) === latest.current.locKey) setScrollTick((t) => t + 1);
      else latest.current.onNavigate(target, replace);
    },
    [],
  );

  useLayoutEffect(() => {
    if (searching) return;
    const was = handled.current;
    const first = was.key === '';
    handled.current = { key: locKey, tick: scrollTick, section: loc.sectionId };
    if (was.key === locKey && was.tick === scrollTick) return;
    if (spyWrote.current === locKey && was.tick === scrollTick) {
      spyWrote.current = null;
      return;
    }
    pinned.current = null;
    clearTimeout(restTimer.current);
    if (first && loc.subId === null) return;
    const target = loc.subId === null ? article.current : document.querySelector<HTMLElement>(`[data-sub="${CSS.escape(loc.subId)}"]`);
    if (!target) return;
    const smooth = !reducedMotion && !first && was.section === loc.sectionId;
    lockUntil.current = performance.now() + (smooth ? SMOOTH_LOCK_MS : INSTANT_LOCK_MS);
    target.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
    readerInputAt.current = Number.NEGATIVE_INFINITY;
    if (loc.subId === null) return;
    const pin = { at: smooth ? null : scrollerOf().scrollTop, moved: false };
    pinned.current = pin;
    if (smooth)
      restTimer.current = setTimeout(() => {
        if (pin.at === null && !pin.moved) pin.at = scrollerOf().scrollTop;
      }, SMOOTH_LOCK_MS);
  }, [locKey, loc.sectionId, loc.subId, scrollTick, searching, reducedMotion]);

  // Scroll-spy: the heading in the reading band becomes the `sub` in the URL (replace, debounced), so a copied link lands where the reader is.
  useEffect(() => {
    if (searching) return;
    const headings = Array.from(document.querySelectorAll<HTMLElement>('.guide-doc [data-sub]'));
    if (headings.length === 0 || typeof IntersectionObserver === 'undefined') return;
    const order = headings.map((h) => h.dataset.sub!);
    const root = document.querySelector<HTMLElement>('.shell__main');
    let state = spyInitial(order);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    // The last heading of a short ending may never reach the band: at the very bottom it is the one being read, whatever else is in the band.
    let atBottom = false;
    const last = order.at(-1)!;
    const reading = () => (atBottom ? last : state.active);
    // Where every heading sits now. The observer only reports a heading that enters or leaves the band, so after a jump that carries
    // a heading from below the band to above it (or back) in one step, its last report is stale.
    const measure = (): SpyEntry[] => {
      const box = (root ?? document.documentElement).getBoundingClientRect();
      const top = root ? box.top : 0;
      const bottom = top + (root ? box.height : window.innerHeight) * READING_BAND;
      return headings.map((h) => {
        const r = h.getBoundingClientRect();
        return { id: h.dataset.sub!, intersecting: r.bottom >= top && r.top <= bottom, above: r.top < top };
      });
    };
    const apply = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (pinned.current || performance.now() < lockUntil.current) return;
        state = spyReduce(state, measure());
        const id = reading();
        if (id === null || id === latest.current.loc.subId) return;
        const target = { sectionId: latest.current.loc.sectionId, subId: id };
        spyWrote.current = keyOf(target);
        latest.current.onNavigate(target, true);
      }, SPY_DEBOUNCE_MS);
    };
    const feed = (entries: SpyEntry[]) => {
      state = spyReduce(state, entries);
      if (pinned.current) return;
      if (performance.now() < lockUntil.current) {
        clearTimeout(settle);
        settle = setTimeout(apply, lockUntil.current - performance.now() + 50);
      } else apply();
    };
    const io = new IntersectionObserver(
      (entries) =>
        feed(
          entries.map((e) => ({ id: (e.target as HTMLElement).dataset.sub!, intersecting: e.isIntersecting, above: e.boundingClientRect.top < (e.rootBounds?.top ?? 0) })),
        ),
      { root, rootMargin: SPY_MARGIN, threshold: 0 },
    );
    headings.forEach((h) => io.observe(h));
    let idle: ReturnType<typeof setTimeout> | undefined;
    const unpin = () => {
      pinned.current = null;
      feed([]);
    };
    const onScroll = () => {
      const scroller = scrollerOf();
      const pin = pinned.current;
      if (pin) {
        const now = performance.now();
        if (now - readerInputAt.current < READER_SCROLL_MS) {
          // The reader took over; whatever the jump was doing is over.
          lockUntil.current = 0;
          unpin();
        } else if (pin.at !== null) {
          if (Math.abs(scroller.scrollTop - pin.at) >= 2) unpin();
        } else {
          pin.moved = true;
          if (!HAS_SCROLLEND) {
            clearTimeout(idle);
            idle = setTimeout(() => {
              if (pinned.current === pin && pin.at === null) pin.at = scrollerOf().scrollTop;
            }, SCROLL_IDLE_MS);
          }
        }
      }
      atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      feed([]);
    };
    const onScrollEnd = () => {
      if (pinned.current?.at === null) pinned.current.at = scrollerOf().scrollTop;
    };
    const onReaderInput = () => {
      readerInputAt.current = performance.now();
    };
    const onPointerDown = (e: PointerEvent) => {
      // Only the scroll area itself, which is its scrollbar: a click on its content is not a scroll.
      if (e.target === root) onReaderInput();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(e.key)) return;
      // A focused link or button leaves the arrows to the page; Space presses a button instead of scrolling.
      const kind = targetKind(e.target);
      if (kind === 'body' || kind === 'link' || (kind === 'button' && e.key !== ' ')) onReaderInput();
    };
    const scrollHost = root ?? window;
    scrollHost.addEventListener('scroll', onScroll, { passive: true });
    scrollHost.addEventListener('scrollend', onScrollEnd);
    scrollHost.addEventListener('wheel', onReaderInput, { passive: true });
    scrollHost.addEventListener('touchstart', onReaderInput, { passive: true });
    scrollHost.addEventListener('pointerdown', onPointerDown as EventListener);
    window.addEventListener('keydown', onKey);
    return () => {
      io.disconnect();
      clearTimeout(timer);
      clearTimeout(settle);
      clearTimeout(idle);
      scrollHost.removeEventListener('scroll', onScroll);
      scrollHost.removeEventListener('scrollend', onScrollEnd);
      scrollHost.removeEventListener('wheel', onReaderInput);
      scrollHost.removeEventListener('touchstart', onReaderInput);
      scrollHost.removeEventListener('pointerdown', onPointerDown as EventListener);
      window.removeEventListener('keydown', onKey);
    };
  }, [loc.sectionId, searching]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = guideKeyAction({ key: e.key, target: targetKind(e.target), ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey });
      if (!action || document.querySelector(OPEN_DIALOG)) return;
      if (action === 'search') {
        e.preventDefault();
        searchInput.current?.focus();
        return;
      }
      if (searching) return;
      const step = stepSubsection(docs, latest.current.loc, action === 'next' ? 1 : -1);
      if (!step) return;
      e.preventDefault();
      goTo(step, true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [docs, goTo, searching]);

  const sectionPager = (target: GuideDocsSectionView | undefined, dir: 'prev' | 'next') => {
    if (!target) return <span />;
    const place = { sectionId: target.id, subId: null };
    return (
      <a
        href={hrefFor(place)}
        className={`guide-pager__card guide-pager__card--${dir}`}
        onClick={(e) => {
          if (!isPlainClick(e)) return;
          e.preventDefault();
          goTo(place);
        }}
      >
        <span className="guide-pager__dir">
          {dir === 'prev' && <ArrowLeft size={14} aria-hidden="true" />}
          {dir === 'prev' ? 'Previous section' : 'Next section'}
          {dir === 'next' && <ArrowRight size={14} aria-hidden="true" />}
        </span>
        <span className="guide-pager__title">{target.title}</span>
      </a>
    );
  };

  const sectionDone = sectionProgress(current, reviewed);

  return (
    <section className="guide" aria-label="Quick guide">
      <GuideContentsSelect docs={docs} loc={loc} reviewed={reviewed} onGo={goTo} />
      <aside className="guide__side">
        <GuideSearchBox
          value={term}
          onChange={setTerm}
          inputRef={searchInput}
          onSubmit={() => {
            const first = document.querySelector<HTMLElement>('.guide-results a.guide-hit');
            first?.click();
          }}
        />
        <div className="guide-progress">
          <div className="guide-progress__row">
            <p className="guide-progress__count" role="status">
              <strong>
                {progress.done} of {progress.total}
              </strong>{' '}
              reviewed
            </p>
            <button type="button" className="guide-progress__reset" aria-label="Reset progress" disabled={progress.done === 0} onClick={() => setMarks(new Set())}>
              <RotateCcw size={13} aria-hidden="true" /> Reset
            </button>
          </div>
          <div className="guide-progress__track" role="progressbar" aria-label="Subsections reviewed" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
            <span className="guide-progress__fill" style={{ transform: `scaleX(${progress.total === 0 ? 0 : progress.done / progress.total})` }} />
          </div>
        </div>
        <GuideToc docs={docs} loc={loc} reviewed={reviewed} hrefFor={hrefFor} onGo={goTo} />
        <p className="guide__keys">
          <kbd>J</kbd> <kbd>K</kbd> step through <span aria-hidden="true">·</span> <kbd>/</kbd> search
        </p>
      </aside>

      {searching ? (
        <GuideSearchResults docs={docs} term={term} hrefFor={hrefFor} onGo={goTo} />
      ) : (
        <article key={current.id} ref={article} className="guide-doc" aria-labelledby="guide-section-title">
          <header className="guide-doc__head">
            <p className="guide-eyebrow">
              Section {sectionIndex + 1} of {docs.sections.length}
              <span aria-hidden="true"> · </span>
              <span className="guide-eyebrow__progress">
                {sectionDone.done} of {sectionDone.total} reviewed
              </span>
            </p>
            <h2 id="guide-section-title">{current.title}</h2>
            <p className="guide-doc__lead">{current.summary}</p>
          </header>
          {current.subsections.map((u, i) => (
            <Subsection key={u.id} section={current} sub={u} index={i} reviewed={reviewed.has(subKey(current.id, u.id))} chapters={chapters} onToggle={() => toggleReviewed(subKey(current.id, u.id))} onWatch={onWatch} />
          ))}
          <nav className="guide-pager" aria-label="Sections">
            {sectionPager(prev, 'prev')}
            {sectionPager(next, 'next')}
          </nav>
        </article>
      )}
    </section>
  );
}

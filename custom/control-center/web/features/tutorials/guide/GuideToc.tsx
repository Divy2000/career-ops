import { Check, ChevronRight, Circle, CircleCheck } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { sectionProgress, subKey, type GuideLocation } from '../../../lib/guide';
import type { GuideDocs } from '@shared/api';

const isPlainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

const RADIUS = 8;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** How much of a section is reviewed: a ring that fills, and a check when it is complete. Decorative; the link says the numbers. */
function ProgressRing({ done, total }: { done: number; total: number }) {
  const complete = total > 0 && done === total;
  return (
    <span className={`guide-ring ${complete ? 'guide-ring--done' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 22 22" width="22" height="22">
        <circle className="guide-ring__track" cx="11" cy="11" r={RADIUS} />
        <circle className="guide-ring__fill" cx="11" cy="11" r={RADIUS} strokeDasharray={CIRCUMFERENCE} style={{ strokeDashoffset: CIRCUMFERENCE * (1 - (total === 0 ? 0 : done / total)) }} />
      </svg>
      {complete && <Check size={12} strokeWidth={3} className="guide-ring__check" />}
    </span>
  );
}

interface Props {
  docs: GuideDocs;
  loc: GuideLocation;
  reviewed: ReadonlySet<string>;
  hrefFor: (loc: GuideLocation) => string;
  onGo: (loc: GuideLocation) => void;
}

/**
 * Which sections show their subsections. Whenever the section being read changes, only that one is open; the chevrons open or close any
 * section in between without navigating.
 */
function useOpenSections(active: string) {
  const [state, setState] = useState(() => ({ active, open: new Set([active]) as ReadonlySet<string> }));
  let open = state.open;
  if (state.active !== active) {
    open = new Set([active]);
    setState({ active, open });
  }
  const toggle = (id: string) =>
    setState((prev) => {
      const next = new Set(prev.open);
      if (!next.delete(id)) next.add(id);
      return { ...prev, open: next };
    });
  return { open, toggle };
}

/** The sticky two-level contents: every section with its progress ring and short label, and a collapsible list of its subsections. */
export function GuideToc({ docs, loc, reviewed, hrefFor, onGo }: Props) {
  const nav = useRef<HTMLElement>(null);
  const { open, toggle } = useOpenSections(loc.sectionId);
  const go = (target: GuideLocation) => (e: MouseEvent) => {
    if (!isPlainClick(e)) return;
    e.preventDefault();
    onGo(target);
  };

  // A long contents list scrolls on its own; keep the row being read in view. Only the list moves: scrollIntoView would also
  // cancel a smooth scroll of the page that is under way.
  useEffect(() => {
    const list = nav.current;
    const row = list?.querySelector<HTMLElement>('[data-toc-active="true"]');
    if (!list || !row) return;
    const box = list.getBoundingClientRect();
    const at = row.getBoundingClientRect();
    if (at.top < box.top) list.scrollTop -= box.top - at.top;
    else if (at.bottom > box.bottom) list.scrollTop += at.bottom - box.bottom;
  }, [loc.sectionId, loc.subId]);

  return (
    <nav ref={nav} className="guide-toc" aria-label="Guide contents">
      <ol className="guide-toc__sections">
        {docs.sections.map((s) => {
          const active = s.id === loc.sectionId;
          const progress = sectionProgress(s, reviewed);
          const at = active && loc.subId !== null ? s.subsections.findIndex((u) => u.id === loc.subId) : -1;
          const top = { sectionId: s.id, subId: null };
          // A section whose one subsection repeats its title (every version 1 section) is just the section: a second row would say the same thing.
          const single = s.subsections.length === 1 && s.subsections[0]!.title === s.title;
          const expanded = !single && open.has(s.id);
          const listId = `guide-toc-subs-${s.id}`;
          return (
            <li key={s.id} className={`guide-toc__item ${active ? 'guide-toc__item--active' : ''}`}>
              <div className="guide-toc__row">
                <a
                  href={hrefFor(top)}
                  className={`guide-toc__section ${single ? '' : 'guide-toc__section--expandable'}`}
                  title={s.title}
                  aria-current={active ? 'true' : undefined}
                  data-toc-active={active && loc.subId === null ? 'true' : undefined}
                  onClick={go(top)}
                >
                  <ProgressRing done={progress.done} total={progress.total} />
                  <span className="guide-toc__title">{s.short}</span>
                  <span className="sr-only">
                    , {progress.done} of {progress.total} reviewed
                  </span>
                </a>
                {!single && (
                  <button type="button" className="guide-toc__toggle" aria-expanded={expanded} aria-controls={listId} aria-label={`${s.short} subsections`} onClick={() => toggle(s.id)}>
                    <ChevronRight size={16} strokeWidth={2.25} aria-hidden="true" />
                  </button>
                )}
              </div>
              {!single && (
                <ol id={listId} className="guide-toc__subs" hidden={!expanded} aria-label={`${s.title} subsections`} style={{ '--at': Math.max(at, 0) } as CSSProperties}>
                  <li className="guide-toc__marker" aria-hidden="true" data-visible={at >= 0 ? 'true' : 'false'} />
                  {s.subsections.map((u) => {
                    const here = active && u.id === loc.subId;
                    const marked = reviewed.has(subKey(s.id, u.id));
                    const target = { sectionId: s.id, subId: u.id };
                    return (
                      <li key={u.id}>
                        <a href={hrefFor(target)} className="guide-toc__sub" aria-current={here ? 'true' : undefined} data-toc-active={here ? 'true' : undefined} title={u.title} onClick={go(target)}>
                          <span className="guide-toc__tick" data-reviewed={marked ? 'true' : 'false'} aria-hidden="true">
                            {marked ? <CircleCheck size={14} strokeWidth={2.25} /> : <Circle size={14} strokeWidth={2} />}
                          </span>
                          <span className="guide-toc__sub-title">{u.short}</span>
                          {marked && <span className="sr-only">, reviewed</span>}
                        </a>
                      </li>
                    );
                  })}
                </ol>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The phone replacement for the contents: one select, sticky at the top, with the sections as groups. */
export function GuideContentsSelect({ docs, loc, reviewed, onGo }: Omit<Props, 'hrefFor'>) {
  const value = `${loc.sectionId}/${loc.subId ?? ''}`;
  return (
    <div className="guide-bar">
      <label className="guide-bar__label" htmlFor="guide-contents">
        Contents
      </label>
      <select
        id="guide-contents"
        value={value}
        onChange={(e) => {
          const [sectionId = '', subId = ''] = e.target.value.split('/');
          onGo({ sectionId, subId: subId === '' ? null : subId });
        }}
      >
        {docs.sections.map((s) => (
          <optgroup key={s.id} label={s.short}>
            <option value={`${s.id}/`}>Overview</option>
            {s.subsections.map((u) => (
              <option key={u.id} value={`${s.id}/${u.id}`}>
                {reviewed.has(subKey(s.id, u.id)) ? `${u.short} (reviewed)` : u.short}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

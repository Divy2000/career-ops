import { Check } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { formatTimestamp } from '../../lib/tutorials';
import { watchedFraction, type TutorialProgress } from '../../lib/tutorial-progress';
import type { TutorialPart } from '@shared/api';

const isPlainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

interface Props {
  parts: TutorialPart[];
  activeId: string;
  progress: TutorialProgress;
  hrefFor: (partId: string) => string;
  onOpen: (partId: string) => void;
  /** The chapters of the active part, drawn under its row. */
  activeChapters: ReactNode;
}

/** The playlist of a tutorial in parts: one link per part with its progress, and the chapters of the part that is playing. */
export function PartList({ parts, activeId, progress, hrefFor, onOpen, activeChapters }: Props) {
  const watched = parts.filter((p) => progress[p.id]?.done).length;
  return (
    <aside className="card tut__chapters tut-parts" aria-labelledby="tut-parts-title">
      <div className="tut-parts__head">
        <h2 id="tut-parts-title">Parts</h2>
        <span className="tut-parts__count">
          {watched} of {parts.length} watched
        </span>
      </div>
      <ol className="tut-parts__list">
        {parts.map((p, i) => {
          const active = p.id === activeId;
          const done = progress[p.id]?.done === true;
          const fraction = watchedFraction(progress[p.id], p.duration);
          const percent = Math.round(fraction * 100);
          return (
            <li key={p.id} className={`tut-part ${active ? 'tut-part--active' : ''}`}>
              <a
                href={hrefFor(p.id)}
                className="tut-part__row"
                title={p.title}
                aria-current={active ? 'true' : undefined}
                onClick={(e) => {
                  if (!isPlainClick(e)) return;
                  e.preventDefault();
                  onOpen(p.id);
                }}
              >
                <span className="tut-part__badge" data-done={done ? 'true' : 'false'} aria-hidden={done ? 'true' : undefined}>
                  {done ? <Check size={13} strokeWidth={3} /> : i + 1}
                </span>
                <span className="tut-part__body">
                  <span className="tut-part__line">
                    <span className="tut-part__label">{p.short}</span>
                    <span className="tut-part__len mono">{formatTimestamp(p.duration ?? 0)}</span>
                  </span>
                  <span className="tut-part__track" aria-hidden="true">
                    <span className="tut-part__fill" style={{ transform: `scaleX(${fraction})` }} />
                  </span>
                </span>
                {done ? <span className="sr-only">, watched</span> : percent > 0 && <span className="sr-only">, {percent}% watched</span>}
              </a>
              {active && activeChapters}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

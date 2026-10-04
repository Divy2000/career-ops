import { Search } from 'lucide-react';
import { useMemo, type KeyboardEvent, type MouseEvent, type Ref } from 'react';
import { highlight, searchGuide, searchTerms, type GuideLocation, type SearchField } from '../../../lib/guide';
import type { GuideDocs } from '@shared/api';

const FIELD_LABEL: Record<SearchField, string> = { title: 'Title', summary: 'Summary', text: 'Text', steps: 'Step', tips: 'Tip', caption: 'Figure' };

/** Text with the matched words wrapped in <mark>; built from pieces, never from HTML. */
export function Marked({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlight(text, terms).map((piece, i) =>
        piece.mark ? (
          <mark key={i} className="guide-mark">
            {piece.text}
          </mark>
        ) : (
          piece.text
        ),
      )}
    </>
  );
}

interface BoxProps {
  value: string;
  onChange: (value: string) => void;
  inputRef: Ref<HTMLInputElement>;
  /** Enter: open the first result. */
  onSubmit: () => void;
}

export function GuideSearchBox({ value, onChange, inputRef, onSubmit }: BoxProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSubmit();
    } else if (e.key === 'Escape') {
      // The first Escape clears, the next leaves the field.
      if (value) onChange('');
      else e.currentTarget.blur();
    }
  };
  return (
    <div className="guide-search">
      <Search size={15} aria-hidden="true" className="guide-search__icon" />
      <input ref={inputRef} type="search" aria-label="Search the guide" placeholder="Search the guide" value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} />
      <kbd className="guide-search__hint" aria-hidden="true">
        /
      </kbd>
    </div>
  );
}

interface ResultsProps {
  docs: GuideDocs;
  term: string;
  hrefFor: (loc: GuideLocation) => string;
  onGo: (loc: GuideLocation) => void;
}

const isPlainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

export function GuideSearchResults({ docs, term, hrefFor, onGo }: ResultsProps) {
  const found = useMemo(() => searchGuide(docs, term), [docs, term]);
  const terms = useMemo(() => searchTerms(term), [term]);
  return (
    <section className="guide-results" aria-labelledby="guide-results-title">
      <p className="guide-eyebrow">Search</p>
      <h2 id="guide-results-title" className="guide-results__title">
        Results for <span className="guide-results__term">{term.trim()}</span>
      </h2>
      <p className="guide-results__count" role="status">
        {found.total === 0 ? `No matches for "${term.trim()}". Try fewer or different words.` : `${found.total} ${found.total === 1 ? 'result' : 'results'} in ${found.groups.length} ${found.groups.length === 1 ? 'section' : 'sections'}`}
      </p>
      {found.groups.map((g) => (
        <section key={g.sectionId} className="guide-results__group" aria-labelledby={`guide-results-${g.sectionId}`}>
          <h3 id={`guide-results-${g.sectionId}`}>{g.title}</h3>
          <ul>
            {g.hits.map((h) => {
              const loc = { sectionId: h.sectionId, subId: h.subId };
              return (
                <li key={`${h.sectionId}/${h.subId ?? ''}`}>
                  <a
                    href={hrefFor(loc)}
                    className="guide-hit"
                    onClick={(e) => {
                      if (!isPlainClick(e)) return;
                      e.preventDefault();
                      onGo(loc);
                    }}
                  >
                    <span className="guide-hit__head">
                      <span className="guide-hit__title">
                        <Marked text={h.subTitle ?? 'Overview'} terms={terms} />
                      </span>
                      <span className="guide-hit__field">{FIELD_LABEL[h.field]}</span>
                    </span>
                    <span className="guide-hit__excerpt">
                      <Marked text={h.excerpt} terms={terms} />
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </section>
  );
}

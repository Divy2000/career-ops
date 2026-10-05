import type { ReactNode } from 'react';

interface Props {
  tutorial: { title: string; description: string };
  part: { title: string; description: string | null };
  /** The part's number, from 1. */
  number: number;
  total: number;
  /** Drawn next to the title (the captions toggle). */
  action?: ReactNode;
}

/**
 * The heading under the video: the part's description, or the tutorial's when the part has none. With several parts it reads
 * "Part N of M" over the part title; with one it carries the tutorial title.
 */
export function PartHeading({ tutorial, part, number, total, action }: Props) {
  const inParts = total > 1;
  // A single video's part already carries the tutorial description, so the part's own always comes first, whatever the count.
  const description = part.description || tutorial.description;
  return (
    <>
      {inParts && (
        <p className="tut__eyebrow">
          Part {number} of {total}
        </p>
      )}
      <div className="row gap" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{inParts ? part.title : tutorial.title}</h2>
        {action}
      </div>
      {description && (
        <p className="muted tut__description" style={{ margin: 0 }}>
          {description}
        </p>
      )}
    </>
  );
}

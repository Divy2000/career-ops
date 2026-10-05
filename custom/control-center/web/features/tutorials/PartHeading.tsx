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
 * The heading under the video. In parts it reads "Part N of M" over the part title and describes the part, falling back to the
 * tutorial description when the part has none; with one video it is the tutorial's title and description.
 */
export function PartHeading({ tutorial, part, number, total, action }: Props) {
  const inParts = total > 1;
  const description = (inParts ? part.description : null) || tutorial.description;
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

import type { ReactNode } from 'react';
import { localJdPath } from '@shared/local-jd';
import { postingUrl } from '@shared/posting-url';

/**
 * Where a posting reference opens: the saved JD a `local:jds/<file>` reference points at, or an http(s) posting URL.
 * Anything else is undefined, so it renders as text: the reference comes from files other writers fill, and a
 * javascript: or data: URL in href would run in this origin when clicked.
 */
export const postingHref = (ref: string): string | undefined => {
  const jd = localJdPath(ref);
  return jd === null ? postingUrl(ref) ?? undefined : `/api/files/serve?path=${encodeURIComponent(jd)}`;
};

/** A posting reference as a new-tab link when postingHref allows one, else its children as plain text. */
export function PostingRefLink({ posting, className, children }: { posting: string | null | undefined; className?: string; children: ReactNode }) {
  const href = posting ? postingHref(posting) : undefined;
  return href === undefined ? (
    <>{children}</>
  ) : (
    <a className={className} href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

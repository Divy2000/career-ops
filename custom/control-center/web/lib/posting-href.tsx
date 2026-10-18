import type { ReactNode } from 'react';
import { localJdPath } from '@shared/local-jd';

/**
 * An http(s) URL as a link target (trimmed), or undefined. Unlike postingUrl, the write routes' rule, it keeps a long or
 * credentialed URL a file already holds openable: a link needs only a scheme that cannot run script in this origin.
 */
export function httpHref(raw: string | null | undefined): string | undefined {
  const s = raw?.trim();
  if (!s || /[\0\r\n]/.test(s)) return undefined;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? s : undefined;
}

/**
 * Where a posting reference opens: the saved JD a `local:jds/<file>` reference points at, or an http(s) posting URL.
 * Anything else is undefined, so it renders as text: the reference comes from files other writers fill, and a
 * javascript: or data: URL in href would run in this origin when clicked.
 */
export const postingHref = (ref: string): string | undefined => {
  const jd = localJdPath(ref);
  return jd === null ? httpHref(ref) : `/api/files/serve?path=${encodeURIComponent(jd)}`;
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

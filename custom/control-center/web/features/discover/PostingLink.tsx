import type { ReactNode } from 'react';
import { postingUrl } from '@shared/posting-url';

/** Posting URLs come from scans, scan history and AI output: only a real http(s) one becomes a link, since a `javascript:` href runs when clicked. */
export function PostingLink({ url, children }: { url: string; children: ReactNode }) {
  const href = postingUrl(url);
  return href === null ? (
    <span>{children}</span>
  ) : (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

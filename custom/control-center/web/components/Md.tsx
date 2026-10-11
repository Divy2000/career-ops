import Markdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import type { MouseEvent } from 'react';
import { useRouter } from '@tanstack/react-router';

// Rendered documents sit inside a page that already has its h1, so headings shift down one level.
const components: Components = {
  h1: ({ children }) => <h2>{children}</h2>,
  h2: ({ children }) => <h3>{children}</h3>,
  h3: ({ children }) => <h4>{children}</h4>,
};

/**
 * The one markdown renderer for untrusted text (reports, digests, plugin docs, Claude output): sanitized, and with no images,
 * because a remote image in text copied from a feed would be fetched from this local app every time the page loads.
 */
export function SafeMarkdown(props: Omit<Options, 'remarkPlugins' | 'rehypePlugins' | 'disallowedElements'>) {
  return <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} disallowedElements={['img']} {...props} components={{ a: ExternalLink, ...props.components }} />;
}

/** An app path (`/tracker/12`), not `//host` or `/\\host`, which name another site. */
const APP_PATH = /^\/(?![/\\])/;
/** A link that leaves nothing behind in this tab: an in-page anchor, or a scheme the browser hands off (mailto:). */
const STAYS = /^(#|(?!https?:)[a-z][a-z\d+.-]*:)/i;

/**
 * An app path navigates through the router: a plain href would reload the app and drop its in-memory state (the Ask
 * advisor session and its proposals, in-flight starts, unsaved page state). Every other web link, including `//host`
 * and a relative one no app route stands for, opens in a new tab, as every other external link in the app does.
 */
const ExternalLink: NonNullable<Components['a']> = ({ href, children }) => {
  // Optional: the markdown also renders outside the router (tests, static markup), where the link stays a plain href.
  const router = useRouter({ warn: false });
  if (href && APP_PATH.test(href)) {
    const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
      // A modified or non-primary click is the browser's own (open in a new tab or window).
      if (!router || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      void router.navigate({ href });
    };
    return (
      <a href={href} onClick={onClick}>
        {children}
      </a>
    );
  }
  if (!href || STAYS.test(href)) return <a href={href}>{children}</a>;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
};

/** Sanitized markdown for untrusted text (reports, digests, plugin docs). */
export function Md({ text }: { text: string }) {
  return (
    <div className="prose">
      <SafeMarkdown components={components}>{text}</SafeMarkdown>
    </div>
  );
}

const inlineComponents: Components = { p: ({ children }) => <>{children}</> };

/** One line of sanitized markdown (bold, links) with no block wrapper, for list items and table cells. */
export function MdInline({ text }: { text: string }) {
  return (
    <span className="md-inline">
      <SafeMarkdown components={inlineComponents}>{text}</SafeMarkdown>
    </span>
  );
}

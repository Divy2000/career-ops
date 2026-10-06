import Markdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

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

/** A web link opens in a new tab, like every other external link in the app: in this tab it would drop unsaved page state. */
const ExternalLink: NonNullable<Components['a']> = ({ href, children }) =>
  href && /^https?:\/\//i.test(href) ? (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ) : (
    <a href={href}>{children}</a>
  );

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

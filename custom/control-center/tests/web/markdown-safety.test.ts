import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Md, MdInline, SafeMarkdown } from '../../web/components/Md';

const IMG = '![tracker](https://attacker.example/p.png) text <img src="https://attacker.example/q.png">';
const render = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

describe('untrusted markdown never loads remote images', () => {
  it.each([
    ['Md', () => render(createElement(Md, { text: IMG }))],
    ['MdInline', () => render(createElement(MdInline, { text: IMG }))],
    ['SafeMarkdown', () => render(createElement(SafeMarkdown, { children: IMG }))],
  ])('%s drops img elements', (_name, html) => {
    const out = html();
    expect(out).not.toContain('<img');
    expect(out).not.toContain('attacker.example');
  });

  it('still renders links, bold and scripts stay inert', () => {
    const out = render(createElement(MdInline, { text: '**bold** [site](https://example.com/a) <script>alert(1)</script>' }));
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('href="https://example.com/a"');
    expect(out).not.toContain('<script');
  });
});

describe('links in rendered markdown open outside the app (SW3-web-a-07)', () => {
  const LINK = 'See [the posting](https://jobs.example.com/acme/1).';
  it.each([
    ['Md', () => render(createElement(Md, { text: LINK }))],
    ['MdInline', () => render(createElement(MdInline, { text: LINK }))],
    ['SafeMarkdown (session transcripts)', () => render(createElement(SafeMarkdown, { children: LINK }))],
  ])('%s opens a web link in a new tab, so the page and its unsaved state stay', (_name, html) => {
    expect(html()).toContain('<a href="https://jobs.example.com/acme/1" target="_blank" rel="noreferrer noopener">the posting</a>');
  });

  it('a link inside the app, or a mail link, stays as written', () => {
    const out = render(createElement(Md, { text: '[row 3](/tracker/3) [mail](mailto:pat@example.com)' }));
    expect(out).toContain('<a href="/tracker/3">row 3</a>');
    expect(out).toContain('<a href="mailto:pat@example.com">mail</a>');
  });
});

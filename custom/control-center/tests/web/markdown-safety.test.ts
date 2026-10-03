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

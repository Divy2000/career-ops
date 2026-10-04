import { describe, expect, it } from 'vitest';
import { MAX_GUIDE_SUBSECTIONS, guideDocs, guideFileNames, guideFileRefs, parseGuide } from '../../server/domains/tutorial-manifest.mjs';

const image = { type: 'media', kind: 'image', file: 'a.dark.webp', fileLight: 'a.light.webp', alt: 'The Today page.', width: 1440, height: 900 };
const clip = { type: 'media', kind: 'gif', file: 'c.dark.webp', fileLight: 'c.light.webp', poster: 'c.dark.png', posterLight: 'c.light.png', alt: 'A status change.', caption: 'Pick a status.', width: 960, height: 540 };
const sub = (over: Record<string, unknown> = {}) => ({ id: 'launch', title: 'Launch and sign in', summary: 'Open the app with the printed token.', blocks: [{ type: 'text', text: 'Run the launcher.' }], ...over });
const sec = (over: Record<string, unknown> = {}) => ({ id: 'getting-started', title: 'Getting started', summary: 'First steps.', subsections: [sub()], ...over });
const guide = (...sections: unknown[]) => ({ version: 2, sections });
const parse = (value: unknown, chapterCount = 3) => parseGuide(value, { chapterCount });
const withBlock = (block: unknown) => guide(sec({ subsections: [sub({ blocks: [block] })] }));
const withSub = (over: Record<string, unknown>) => guide(sec({ subsections: [sub(over)] }));
const BLOCK = 'sections.0.subsections.0.blocks.0';

describe('parseGuide, version 2', () => {
  it('accepts a full guide and keeps every field', () => {
    const full = guide(
      sec({
        subsections: [
          sub({
            route: '/today?x=1',
            chapter: 2,
            blocks: [
              { type: 'text', text: 'Run the launcher.' },
              { type: 'steps', items: ['Open a terminal.', 'Run it.'] },
              { type: 'tips', items: ['Keep the token private.'] },
              image,
              clip,
            ],
          }),
        ],
      }),
    );
    expect(parse(full)).toEqual({ ok: true, guide: full });
  });

  it('accepts the smallest guide: one section, one subsection, one block, no optional fields', () => {
    const minimal = guide(sec());
    expect(parse(minimal)).toEqual({ ok: true, guide: minimal });
  });

  it.each(['.png', '.jpg', '.jpeg', '.webp'])('accepts an image ending %s, and light files of another image type', (ext) => {
    expect(parse(withBlock({ ...image, file: `a${ext}`, fileLight: 'b.png' })).ok).toBe(true);
  });

  it.each(['.gif', '.webp'])('accepts a clip ending %s with a .jpg or .png poster', (ext) => {
    expect(parse(withBlock({ ...clip, file: `c${ext}`, fileLight: `d${ext}`, poster: 'p.jpg', posterLight: 'q.jpeg' })).ok).toBe(true);
  });

  it('accepts the same subsection id in two different sections', () => {
    expect(parse(guide(sec(), sec({ id: 'other' }))).ok).toBe(true);
  });

  it('accepts exactly the limits and nothing beyond: 300 summary, 600 text and subsection summary, 8 steps, 4 tips, 200 alt and caption, 4096 px', () => {
    const edge = guide(
      sec({
        summary: 'x'.repeat(300),
        subsections: [
          sub({
            summary: 'x'.repeat(600),
            blocks: [
              { type: 'text', text: 'x'.repeat(600) },
              { type: 'steps', items: Array.from({ length: 8 }, () => 'x'.repeat(300)) },
              { type: 'tips', items: Array.from({ length: 4 }, () => 'x'.repeat(300)) },
              { ...image, alt: 'x'.repeat(200), caption: 'x'.repeat(200), width: 4096, height: 1 },
            ],
          }),
        ],
      }),
    );
    expect(parse(edge).ok).toBe(true);
  });

  it('accepts 12 sections and 80 subsections in total', () => {
    const subs = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => sub({ id: `${prefix}${i}` }));
    const sections = Array.from({ length: 10 }, (_, i) => sec({ id: `s${i}`, subsections: subs(8, 'u') }));
    expect(parse(guide(...sections)).ok).toBe(true);
    expect(parse(guide(...Array.from({ length: 12 }, (_, i) => sec({ id: `s${i}`, subsections: subs(i < 8 ? 8 : 4, 'u') })))).ok).toBe(true);
  });

  it('rejects more than 80 subsections in total, naming the limit', () => {
    const subs = Array.from({ length: 8 }, (_, i) => sub({ id: `u${i}` }));
    const sections = Array.from({ length: 11 }, (_, i) => sec({ id: `s${i}`, subsections: subs }));
    expect(MAX_GUIDE_SUBSECTIONS).toBe(80);
    const r = parse(guide(...sections));
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/80 subsections/) });
  });

  it.each([
    ['a version other than 2', { version: 3, sections: [sec()] }, /version/],
    ['version 1 written out (the legacy format has no version)', { version: 1, sections: [sec()] }, /version/],
    ['a version that is a string', { version: '2', sections: [sec()] }, /version/],
    ['an unknown top-level key', { ...guide(sec()), extra: 1 }, /extra/],
    ['no sections', { version: 2 }, /sections/],
    ['an empty section list', guide(), /sections/],
    ['13 sections', guide(...Array.from({ length: 13 }, (_, i) => sec({ id: `s${i}` }))), /sections/],
    ['an unknown section key', guide(sec({ gif: 'a.gif' })), /gif/],
    ['a section without a title', guide(sec({ title: '' })), /sections\.0\.title/],
    ['a section without a summary', guide(sec({ summary: undefined })), /sections\.0\.summary/],
    ['a section summary of 301 characters', guide(sec({ summary: 'x'.repeat(301) })), /sections\.0\.summary/],
    ['a section id that is not slug-safe', guide(sec({ id: 'a b' })), /sections\.0\.id/],
    ['a section id with a slash', guide(sec({ id: 'a/b' })), /sections\.0\.id/],
    ['a section without subsections', guide(sec({ subsections: [] })), /subsections/],
    ['9 subsections in one section', guide(sec({ subsections: Array.from({ length: 9 }, (_, i) => sub({ id: `u${i}` })) })), /subsections/],
    ['an unknown subsection key', withSub({ gif: 'a.gif' }), /gif/],
    ['a subsection without a title', withSub({ title: '' }), /subsections\.0\.title/],
    ['a subsection without a summary', withSub({ summary: undefined }), /subsections\.0\.summary/],
    ['a subsection summary of 601 characters', withSub({ summary: 'x'.repeat(601) }), /subsections\.0\.summary/],
    ['a subsection id that is not slug-safe', withSub({ id: '../x' }), /subsections\.0\.id/],
    ['a negative chapter', withSub({ chapter: -1 }), /chapter/],
    ['a fractional chapter', withSub({ chapter: 1.5 }), /chapter/],
    ['a chapter that does not exist', withSub({ chapter: 3 }), /chapter 3.*3 chapters/],
    ['a subsection without blocks', withSub({ blocks: [] }), /blocks/],
    ['11 blocks', withSub({ blocks: Array.from({ length: 11 }, () => ({ type: 'text', text: 'x' })) }), /blocks/],
    ['a route without a leading slash', withSub({ route: 'today' }), /route/],
    ['a protocol-relative route', withSub({ route: '//evil.example/x' }), /route/],
    ['a route with a parent segment', withSub({ route: '/a/../b' }), /route/],
    ['a route with an encoded parent segment', withSub({ route: '/today/%2e%2e/settings' }), /route/],
    ['a javascript route', withSub({ route: 'javascript:alert(1)' }), /route/],
    ['an unknown block type', withBlock({ type: 'video', file: 'a.mp4' }), /blocks\.0/],
    ['a block with no type', withBlock({ text: 'x' }), /blocks\.0/],
    ['a text block with an unknown key', withBlock({ type: 'text', text: 'x', extra: 1 }), /extra/],
    ['an empty text block', withBlock({ type: 'text', text: '' }), /blocks\.0\.text/],
    ['a text block of 601 characters', withBlock({ type: 'text', text: 'x'.repeat(601) }), /blocks\.0\.text/],
    ['a steps block with no items', withBlock({ type: 'steps', items: [] }), /items/],
    ['a steps block with 9 items', withBlock({ type: 'steps', items: Array.from({ length: 9 }, () => 'x') }), /items/],
    ['an empty step', withBlock({ type: 'steps', items: [''] }), /items/],
    ['a step of 301 characters', withBlock({ type: 'steps', items: ['x'.repeat(301)] }), /items/],
    ['a tips block with no items', withBlock({ type: 'tips', items: [] }), /items/],
    ['a tips block with 5 items', withBlock({ type: 'tips', items: Array.from({ length: 5 }, () => 'x') }), /items/],
    ['a tip of 301 characters', withBlock({ type: 'tips', items: ['x'.repeat(301)] }), /items/],
    ['a media block with an unknown kind', withBlock({ ...image, kind: 'video' }), /blocks\.0/],
    ['an image without a file', withBlock({ ...image, file: undefined }), new RegExp(`${BLOCK}\\.file`)],
    ['an image without a fileLight', withBlock({ ...image, fileLight: undefined }), new RegExp(`${BLOCK}\\.fileLight`)],
    ['a clip without a fileLight', withBlock({ ...clip, fileLight: undefined }), new RegExp(`${BLOCK}\\.fileLight`)],
    ['a clip without a poster', withBlock({ ...clip, poster: undefined }), new RegExp(`${BLOCK}\\.poster`)],
    ['a clip without a posterLight', withBlock({ ...clip, posterLight: undefined }), new RegExp(`${BLOCK}\\.posterLight`)],
    ['an image with a poster (images have none)', withBlock({ ...image, poster: 'p.png' }), /poster/],
    ['an image that is a gif', withBlock({ ...image, file: 'a.gif' }), new RegExp(`${BLOCK}\\.file`)],
    ['an image fileLight that is a gif', withBlock({ ...image, fileLight: 'a.gif' }), new RegExp(`${BLOCK}\\.fileLight`)],
    ['a clip that is a png', withBlock({ ...clip, file: 'c.png' }), new RegExp(`${BLOCK}\\.file`)],
    ['a clip fileLight that is a jpg', withBlock({ ...clip, fileLight: 'c.jpg' }), new RegExp(`${BLOCK}\\.fileLight`)],
    ['a clip poster that is a webp', withBlock({ ...clip, poster: 'c.webp' }), new RegExp(`${BLOCK}\\.poster`)],
    ['a clip posterLight that is a gif', withBlock({ ...clip, posterLight: 'c.gif' }), new RegExp(`${BLOCK}\\.posterLight`)],
    ['an image in a subfolder', withBlock({ ...image, file: 'sub/a.png' }), /file/],
    ['an image that climbs out', withBlock({ ...image, fileLight: '../a.png' }), /fileLight/],
    ['a hidden image', withBlock({ ...image, file: '.a.png' }), /file/],
    ['a clip poster that climbs out', withBlock({ ...clip, posterLight: '../p.png' }), /posterLight/],
    ['an image without alt', withBlock({ ...image, alt: undefined }), /alt/],
    ['an empty alt', withBlock({ ...image, alt: '' }), /alt/],
    ['an alt of 201 characters', withBlock({ ...image, alt: 'x'.repeat(201) }), /alt/],
    ['a caption of 201 characters', withBlock({ ...image, caption: 'x'.repeat(201) }), /caption/],
    ['an empty caption', withBlock({ ...image, caption: '' }), /caption/],
    ['no width', withBlock({ ...image, width: undefined }), /width/],
    ['no height', withBlock({ ...image, height: undefined }), /height/],
    ['a width of 0', withBlock({ ...image, width: 0 }), /width/],
    ['a width of 4097', withBlock({ ...image, width: 4097 }), /width/],
    ['a fractional width', withBlock({ ...image, width: 10.5 }), /width/],
    ['a width that is a string', withBlock({ ...image, width: '100' }), /width/],
    ['a height of 0', withBlock({ ...image, height: 0 }), /height/],
    ['a height of 4097', withBlock({ ...image, height: 4097 }), /height/],
    ['a negative height', withBlock({ ...image, height: -5 }), /height/],
  ])('rejects %s', (_label, value, message) => {
    const r = parse(value);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });

  it('rejects duplicate section ids and names the id', () => {
    expect(parse(guide(sec(), sec({ title: 'Again' })))).toEqual({ ok: false, error: expect.stringMatching(/sections\.1\.id.*duplicate.*"getting-started"/i) });
  });

  it('rejects a duplicate subsection id within a section, naming the section and the id', () => {
    const r = parse(guide(sec({ subsections: [sub(), sub({ title: 'Again' })] })));
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/sections\.0\.subsections\.1\.id.*duplicate.*"launch"/i) });
  });

  it('checks a chapter against the tutorial chapter count, and every chapter is missing when there are none', () => {
    expect(parse(withSub({ chapter: 2 }), 3).ok).toBe(true);
    expect(parse(withSub({ chapter: 0 }), 0)).toEqual({ ok: false, error: expect.stringMatching(/sections\.0\.subsections\.0\.chapter.*chapter 0.*0 chapters/) });
  });
});

describe('guideFileNames and guideFileRefs', () => {
  const v2 = guide(sec({ subsections: [sub({ blocks: [{ type: 'text', text: 'x' }, image, clip, { ...image, file: 'a.dark.webp', fileLight: 'b.light.webp' }] })] }));

  it('lists every media file of a version 2 guide once, in block order: file, fileLight, poster, posterLight', () => {
    const r = parse(v2);
    if (!r.ok) throw new Error(r.error);
    expect(guideFileNames(r.guide)).toEqual(['a.dark.webp', 'a.light.webp', 'c.dark.webp', 'c.light.webp', 'c.dark.png', 'c.light.png', 'b.light.webp']);
  });

  it('says what each file is, naming the light variants, so a missing one can be reported', () => {
    const r = parse(v2);
    if (!r.ok) throw new Error(r.error);
    expect(guideFileRefs(r.guide)).toEqual([
      { name: 'a.dark.webp', kind: 'image' },
      { name: 'a.light.webp', kind: 'light image' },
      { name: 'c.dark.webp', kind: 'gif' },
      { name: 'c.light.webp', kind: 'light gif' },
      { name: 'c.dark.png', kind: 'poster' },
      { name: 'c.light.png', kind: 'light poster' },
      { name: 'b.light.webp', kind: 'light image' },
    ]);
  });

  it('keeps the version 1 order and kinds: gif then poster per section', () => {
    const r = parse({ sections: [{ id: 'a', title: 'A', summary: 's', gif: 'a.gif', poster: 'a.jpg', steps: ['x'] }, { id: 'b', title: 'B', summary: 's', gif: 'b.gif', steps: ['x'] }] });
    if (!r.ok) throw new Error(r.error);
    expect(guideFileNames(r.guide)).toEqual(['a.gif', 'a.jpg', 'b.gif']);
    expect(guideFileRefs(r.guide)).toEqual([{ name: 'a.gif', kind: 'gif' }, { name: 'a.jpg', kind: 'poster' }, { name: 'b.gif', kind: 'gif' }]);
  });
});

describe('guideDocs: the version 2 view of either format', () => {
  const docs = (value: unknown) => {
    const r = parse(value);
    if (!r.ok) throw new Error(r.error);
    return guideDocs(r.guide);
  };

  it('adapts a version 1 guide: each section becomes one section with one subsection holding summary, clip, steps and tips', () => {
    const v1 = {
      sections: [
        { id: 'today', title: 'Today', summary: 'The daily shortlist.', route: '/today', gif: 'today.gif', poster: 'today.jpg', steps: ['Open Today.', 'Pick a row.'], tips: ['Press j.'], chapter: 1 },
      ],
    };
    expect(docs(v1)).toEqual({
      version: 1,
      legacy: true,
      sections: [
        {
          id: 'today',
          title: 'Today',
          summary: 'The daily shortlist.',
          subsections: [
            {
              id: 'today',
              title: 'Today',
              summary: '',
              route: '/today',
              chapter: 1,
              blocks: [
                { type: 'text', text: 'The daily shortlist.' },
                { type: 'media', kind: 'gif', file: 'today.gif', fileLight: null, poster: 'today.jpg', posterLight: null, alt: 'Today', caption: null, width: null, height: null },
                { type: 'steps', items: ['Open Today.', 'Pick a row.'] },
                { type: 'tips', items: ['Press j.'] },
              ],
            },
          ],
        },
      ],
    });
  });

  it('leaves out what a version 1 section does not have: no poster, no tips, no route, no chapter', () => {
    const out = docs({ sections: [{ id: 'a', title: 'A', summary: 's', gif: 'a.webp', steps: ['one'] }] });
    const subsection = out.sections[0]!.subsections[0]!;
    expect(subsection).toMatchObject({ route: null, chapter: null });
    expect(subsection.blocks.map((b: { type: string }) => b.type)).toEqual(['text', 'media', 'steps']);
    expect(subsection.blocks[1]).toMatchObject({ file: 'a.webp', poster: null, fileLight: null });
  });

  it('keeps every version 1 section, in order', () => {
    const out = docs({ sections: ['a', 'b', 'c'].map((id) => ({ id, title: id, summary: 's', gif: `${id}.gif`, steps: ['x'] })) });
    expect(out.sections.map((s: { id: string }) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('normalizes a version 2 guide: absent optional fields become null, nothing is added or dropped', () => {
    const out = docs(guide(sec({ subsections: [sub({ blocks: [{ type: 'text', text: 'T' }, image, clip] })] })));
    expect(out.version).toBe(2);
    expect(out.legacy).toBe(false);
    expect(out.sections[0]!.subsections[0]).toEqual({
      id: 'launch',
      title: 'Launch and sign in',
      summary: 'Open the app with the printed token.',
      route: null,
      chapter: null,
      blocks: [
        { type: 'text', text: 'T' },
        { type: 'media', kind: 'image', file: 'a.dark.webp', fileLight: 'a.light.webp', poster: null, posterLight: null, alt: 'The Today page.', caption: null, width: 1440, height: 900 },
        { type: 'media', kind: 'gif', file: 'c.dark.webp', fileLight: 'c.light.webp', poster: 'c.dark.png', posterLight: 'c.light.png', alt: 'A status change.', caption: 'Pick a status.', width: 960, height: 540 },
      ],
    });
  });
});

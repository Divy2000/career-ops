import type { List, PhrasingContent } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const MAX_CHARS = 160;

/** A run of rendered text; `href` makes it a link. Spans carry no markdown, so nothing can be cut mid-syntax. */
export interface DigestSpan {
  text: string;
  bold?: true;
  href?: string;
}

export const spansText = (spans: DigestSpan[]): string => spans.map((s) => s.text).join('');

const parser = unified().use(remarkParse).use(remarkGfm);

/** What a link labelled with its own address shows: the host of a web address, the address alone for mailto:/tel:, else the label. */
function addressLabel(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host !== '') return parsed.host;
  if (parsed.protocol === 'mailto:' || parsed.protocol === 'tel:') return url.slice(parsed.protocol.length) || url;
  return url;
}

type Definitions = Map<string, string>;

/** Phrasing nodes to spans. Images, footnote references, raw HTML and struck-through (withdrawn) text are dropped; a link whose label is its own address shows it compactly. */
function flatten(nodes: PhrasingContent[], bold: true | undefined, href: string | undefined, out: DigestSpan[], defs: Definitions): void {
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
      case 'inlineCode':
        out.push({ text: n.value, ...(bold ? { bold } : {}), ...(href ? { href } : {}) });
        break;
      case 'break':
        out.push({ text: ' ', ...(bold ? { bold } : {}), ...(href ? { href } : {}) });
        break;
      case 'strong':
        flatten(n.children, true, href, out, defs);
        break;
      case 'emphasis':
        flatten(n.children, bold, href, out, defs);
        break;
      case 'link': {
        const label = n.children.length === 1 && n.children[0]!.type === 'text' ? (n.children[0] as { value: string }).value : null;
        if (label !== null && label === n.url) out.push({ text: addressLabel(n.url), ...(bold ? { bold } : {}), href: n.url });
        else flatten(n.children, bold, n.url, out, defs);
        break;
      }
      case 'linkReference':
        // The label is the visible text; the address comes from the matching definition, if there is one.
        flatten(n.children, bold, defs.get(n.identifier) ?? href, out, defs);
        break;
      case 'image':
      case 'imageReference':
      case 'footnoteReference':
      case 'html':
      case 'delete':
        break;
    }
  }
}

/** Collapses the whitespace left behind by dropped nodes. */
function tidy(spans: DigestSpan[]): DigestSpan[] {
  const out: DigestSpan[] = [];
  let prevSpace = true;
  for (const s of spans) {
    let text = s.text.replace(/\s+/g, ' ');
    if (prevSpace) text = text.replace(/^ /, '');
    if (text === '') continue;
    prevSpace = text.endsWith(' ');
    out.push({ ...s, text });
  }
  const last = out[out.length - 1];
  if (last) last.text = last.text.replace(/ $/, '');
  return out.filter((s) => s.text !== '');
}

// A period after these ends no sentence: dotted initials (U.S., e.g.) are caught by shape, the rest by name.
const ABBREVIATIONS = new Set(['jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'no', 'nos', 'vs', 'etc', 'approx', 'dept', 'gov', 'inc', 'corp', 'co', 'ltd', 'mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'est', 'fig']);
// These are also words ("the Fed.", "the SEC."), so they abbreviate only inside a citation: "90 Fed. Reg. 45678", "Pub. L. 117".
const CITATION_WORDS = new Set(['fed', 'reg', 'sec', 'pub', 'rev', 'pt']);
const CITATION_NEXT = /^\p{Lu}\p{L}{0,3}\.$/u;
const CAPITALIZED = /^\p{Lu}/u;
// Closers in every quoting style ("" '' “” „“ «» »« 「」 『』 ...). French spacing puts a space before a closing
// guillemet ("définitif. »"); a Danish » after a space opens the next sentence, but sits on its word, so the lookahead refuses it.
const SENTENCE_PUNCTUATION = /[.!?](?: [\u00bb\u203a]|[\u00ab\u00bb\u2039\u203a"')\]}\u2018\u2019\u201c\u201d\u3009\u300b\u300d\u300f\u3011\u3015\u3017\u3019\u301b\uff02\uff07\uff09\uff3d\uff5d])*(?=\s|$)/gu;
const OPENERS = /^[(["'{\u2018\u201a\u201c\u201e\u00ab\u00bb\u2039\u203a\u3008\u300a\u300c\u300e\u3010\u3014\u3016\u3018\u301a\uff02\uff07\uff08\uff3b\uff5b]+/u;
// A lone capital after these is a lettered part ("Schedule A.", "Part B."), not a middle initial.
const LETTERED_PARTS = new Set(['schedule', 'part', 'plan', 'title', 'section', 'appendix', 'exhibit', 'form', 'annex', 'item', 'tier', 'type', 'class', 'category', 'group']);

const SPACE = /\s/u;
const NEXT_WORD = /(\s+)(\S+)/uy;

/** The whitespace-delimited word ending at `end`, read backwards from it, and where it starts. */
function wordBefore(text: string, end: number): { word: string; start: number } {
  let start = end;
  while (start > 0 && !SPACE.test(text[start - 1]!)) start--;
  return { word: text.slice(start, end), start };
}

/**
 * Whether the . ! or ? at `i` (with its closing quotes and brackets, up to `after`) ends a sentence: a period after an
 * abbreviation, or before a lowercase word or a number ("Oct. 15"), is no end. Text from `ownEnd` on belongs to later spans:
 * it still shows an abbreviation or initial ("Fed. [Reg.](u)", "J. [Trump](u)"), or a number ("Fed. *Reg.* 45678"), but a
 * lowercase word there does not carry the sentence on ("Oct. 15. [source](u)", "here. ![img](u) end.").
 * Reads only the words next to `i`, so scanning a whole text costs time linear in its length.
 */
function endsSentence(text: string, i: number, after: number, ownEnd: number): boolean {
  NEXT_WORD.lastIndex = after;
  const next = NEXT_WORD.exec(text);
  const nextWord = next?.[2];
  if (text[i] === '.') {
    // "(U.S." and "\"e.g." are the same abbreviations: opening brackets and quotes are not part of the word.
    const own = wordBefore(text, i);
    const word = own.word.replace(OPENERS, '');
    if (/^(?:\p{L}\.)+\p{L}$/u.test(word)) return false;
    if (ABBREVIATIONS.has(word.toLowerCase())) return false;
    if (CITATION_WORDS.has(word.toLowerCase()) && nextWord !== undefined && CITATION_NEXT.test(nextWord)) return false;
    // A middle initial sits between two capitalized words ("Donald J. Trump"); "schedule B. Employers" ends.
    const before = own.start > 0 ? wordBefore(text, own.start - 1).word : '';
    if (/^\p{Lu}$/u.test(word) && CAPITALIZED.test(before) && !LETTERED_PARTS.has(before.toLowerCase()) && nextWord !== undefined && CAPITALIZED.test(nextWord)) return false;
  }
  if (next === null) return true;
  const carriesOn = after + next[1]!.length < ownEnd ? /[\p{Ll}\d]/u : /\d/u;
  return !carriesOn.test(next[2]![0]!);
}

/** A plain span, or a link: its consecutive spans sharing one target. */
interface Piece {
  first: number;
  last: number;
  start: number;
  end: number;
}

function pieces(spans: DigestSpan[]): Piece[] {
  const out: Piece[] = [];
  let offset = 0;
  for (let i = 0; i < spans.length; ) {
    let j = i + 1;
    if (spans[i]!.href) while (j < spans.length && spans[j]!.href === spans[i]!.href) j++;
    let length = 0;
    for (let k = i; k < j; k++) length += spans[k]!.text.length;
    out.push({ first: i, last: j - 1, start: offset, end: offset + length });
    offset += length;
    i = j;
  }
  return out;
}

/**
 * Keeps spans up to the first sentence end, judged over the text of every span so a period at a span's edge sees its
 * neighbours ("[Donald](u) J.", "Donald J. [Trump](u)"). An end belongs to the piece holding its punctuation and counts only
 * when its closing quotes stay inside that piece. A link whose label holds the end is kept whole; its end is judged with
 * the text after the link in view, so "[rule 5.](u) applies" reads on.
 */
function firstSentence(spans: DigestSpan[]): DigestSpan[] {
  const text = spansText(spans);
  const all = pieces(spans);
  let p = 0;
  for (const m of text.matchAll(SENTENCE_PUNCTUATION)) {
    const i = m.index!;
    const after = i + m[0].length;
    while (all[p]!.end <= i) p++;
    const piece = all[p]!;
    const link = spans[piece.first]!.href !== undefined;
    if (after > piece.end || !endsSentence(text, i, after, link ? Infinity : piece.end)) continue;
    const kept = spans.slice(0, piece.last + 1);
    if (!link) kept[piece.last] = { ...spans[piece.last]!, text: spans[piece.last]!.text.slice(0, after - piece.start) };
    return kept;
  }
  return spans;
}

/** Ends kept text with an ellipsis after its trailing spaces; a link label never takes it. */
function ellipsize(out: DigestSpan[]): DigestSpan[] {
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    const text = last.text.trimEnd();
    if (text !== '') {
      out[out.length - 1] = { ...last, text };
      break;
    }
    out.pop();
  }
  const last = out[out.length - 1];
  if (last && !last.href) out[out.length - 1] = { ...last, text: `${last.text}…` };
  else out.push({ text: '…' });
  return out;
}

/** Clips rendered text to the limit. A link is kept whole or dropped; plain text is cut with an ellipsis. */
function clip(spans: DigestSpan[]): DigestSpan[] {
  const out: DigestSpan[] = [];
  for (const piece of pieces(spans)) {
    const room = MAX_CHARS - piece.start;
    const whole = spans.slice(piece.first, piece.last + 1);
    if (piece.end - piece.start <= room) {
      out.push(...whole);
      continue;
    }
    const s = spans[piece.first]!;
    if (s.href) {
      // A link longer than the limit on its own is still the line; cut, it would mislabel its target.
      if (out.length === 0) return whole;
      return ellipsize(out);
    }
    out.push({ ...s, text: s.text.slice(0, Math.max(room, 0)) });
    return ellipsize(out);
  }
  return out;
}

// Definitions are valid anywhere in the document (including nested under a
// bullet), and when a label is defined twice the first one wins, as in CommonMark.
function collectDefinitions(node: { type: string; identifier?: string; url?: string; children?: unknown[] }, defs: Definitions = new Map()): Definitions {
  if (node.type === 'definition' && node.identifier && node.url !== undefined && !defs.has(node.identifier)) {
    defs.set(node.identifier, node.url);
  }
  for (const child of (node.children ?? []) as (typeof node)[]) collectDefinitions(child, defs);
  return defs;
}

/** A bold lead stands alone only as a full sentence; a label ("Effective date:", "USCIS") needs the text after it. */
const HEADLINE = new RegExp(`(?:${SENTENCE_PUNCTUATION.source})$`, 'u');
const isHeadline = (lead: DigestSpan[]): boolean => HEADLINE.test(spansText(lead));

/**
 * Compact highlights from a policy digest section: for each top-level bullet its bold lead when that is a sentence, or
 * else its first sentence, clipped on rendered text. The full digest lives on Sponsorship.
 */
export function summarizeDigest(body: string, max = 4): DigestSpan[][] {
  const tree = parser.parse(body);
  const defs: Definitions = collectDefinitions(tree);
  const list = tree.children.filter((n): n is List => n.type === 'list');
  const out: DigestSpan[][] = [];
  for (const item of list.flatMap((l) => l.children)) {
    const para = item.children.find((c) => c.type === 'paragraph');
    if (para?.type !== 'paragraph') continue;
    const spans: DigestSpan[] = [];
    flatten(para.children, undefined, undefined, spans, defs);
    const first = para.children[0];
    const lead = first?.type === 'strong' ? (() => {
      const l: DigestSpan[] = [];
      flatten([first], undefined, undefined, l, defs);
      return tidy(l);
    })() : null;
    const line = clip(tidy(lead && isHeadline(lead) ? lead : firstSentence(tidy(spans))));
    if (line.length === 0) continue;
    out.push(line);
    if (out.length === max) break;
  }
  return out;
}

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
// A lone capital after these is a lettered part ("Schedule A.", "Part B."), not a middle initial.
const LETTERED_PARTS = new Set(['schedule', 'part', 'plan', 'title', 'section', 'appendix', 'exhibit', 'form', 'annex', 'item', 'tier', 'type', 'class', 'category', 'group']);

/**
 * Where the first sentence of `text` ends (after its . ! or ? and any closing quotes or brackets), or -1: a period after an abbreviation, or before a lowercase
 * word or a number ("Oct. 15"), is no end. Ends before `from` are skipped: that text is context for the words before a period.
 * Text from `ownEnd` on belongs to later spans: it still shows an abbreviation or initial ("Fed. [Reg.](u)", "J. [Trump](u)"),
 * or a number ("Fed. *Reg.* 45678"), but a lowercase word there does not carry the sentence on ("Oct. 15. [source](u)", "here. ![img](u) end.").
 */
function sentenceEnd(text: string, from = 0, ownEnd = Infinity): number {
  // Closing quotes and brackets after the punctuation belong to the sentence: 'said "under review." Posts will'.
  for (const m of text.matchAll(/[.!?]["')\]\u2019\u201d]*(?=\s|$)/gu)) {
    const i = m.index!;
    const after = i + m[0].length;
    if (i < from) continue;
    const next = /^(\s+)(\S+)/.exec(text.slice(after));
    const nextWord = next?.[2];
    if (text[i] === '.') {
      // "(U.S." and "\"e.g." are the same abbreviations: opening brackets and quotes are not part of the word.
      const words = text.slice(0, i).split(/\s/);
      const word = (words.pop() ?? '').replace(/^[(["'\u2018\u201c]+/u, '');
      if (/^(?:\p{L}\.)+\p{L}$/u.test(word)) continue;
      if (ABBREVIATIONS.has(word.toLowerCase())) continue;
      if (CITATION_WORDS.has(word.toLowerCase()) && nextWord !== undefined && CITATION_NEXT.test(nextWord)) continue;
      // A middle initial sits between two capitalized words ("Donald J. Trump"); "schedule B. Employers" ends.
      const before = words.pop() ?? '';
      if (/^\p{Lu}$/u.test(word) && CAPITALIZED.test(before) && !LETTERED_PARTS.has(before.toLowerCase()) && nextWord !== undefined && CAPITALIZED.test(nextWord)) continue;
    }
    if (next === null) return after;
    const carriesOn = after + next[1]!.length < ownEnd ? /[\p{Ll}\d]/u : /\d/u;
    if (!carriesOn.test(next[2]![0]!)) return after;
  }
  return -1;
}

/**
 * Keeps spans up to the first sentence end. A link (its consecutive spans sharing one target) whose label holds the end
 * is kept whole; its end is judged with the text after the link in view, so "[rule 5.](u) applies" reads on.
 */
function firstSentence(spans: DigestSpan[]): DigestSpan[] {
  const out: DigestSpan[] = [];
  for (let i = 0; i < spans.length; ) {
    const s = spans[i]!;
    if (!s.href) {
      // The text kept so far holds no sentence end, but its last words decide whether a period here is one ("[Donald](u) J."),
      // and so do the words after it ("Donald J. [Trump](u)").
      const before = spansText(out);
      const spanEnd = before.length + s.text.length;
      const end = sentenceEnd(before + s.text + spansText(spans.slice(i + 1)), before.length, spanEnd);
      if (end !== -1 && end <= spanEnd) {
        out.push({ ...s, text: s.text.slice(0, end - before.length) });
        return out;
      }
      out.push(s);
      i++;
      continue;
    }
    let j = i;
    while (j < spans.length && spans[j]!.href === s.href) j++;
    const link = spans.slice(i, j);
    const label = spansText(link);
    const before = spansText(out);
    out.push(...link);
    const end = sentenceEnd(before + label + spansText(spans.slice(j)), before.length);
    if (end !== -1 && end <= before.length + label.length) return out;
    i = j;
  }
  return out;
}

/** Clips rendered text to the limit. A link is kept whole or dropped; plain text is cut with an ellipsis. */
function clip(spans: DigestSpan[]): DigestSpan[] {
  const out: DigestSpan[] = [];
  let used = 0;
  for (const s of spans) {
    const room = MAX_CHARS - used;
    if (s.text.length <= room) {
      out.push(s);
      used += s.text.length;
      continue;
    }
    if (s.href) {
      if (out.length === 0) out.push(s);
      else out[out.length - 1] = { ...out[out.length - 1]!, text: `${out[out.length - 1]!.text.trimEnd()}…` };
    } else {
      out.push({ ...s, text: `${s.text.slice(0, Math.max(room, 0)).trimEnd()}…` });
    }
    return out;
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
const isHeadline = (lead: DigestSpan[]): boolean => /[.!?]["')\]\u2019\u201d]*$/u.test(spansText(lead));

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

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

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

type Definitions = Map<string, string>;

/** Phrasing nodes to spans. Images, footnote references and raw HTML are dropped; a link whose label is its own address shows only the host. */
function flatten(nodes: PhrasingContent[], bold: true | undefined, href: string | undefined, out: DigestSpan[], defs: Definitions): void {
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
      case 'inlineCode':
        out.push({ text: n.value, ...(bold ? { bold } : {}), ...(href ? { href } : {}) });
        break;
      case 'break':
        out.push({ text: ' ', ...(bold ? { bold } : {}) });
        break;
      case 'strong':
        flatten(n.children, true, href, out, defs);
        break;
      case 'emphasis':
      case 'delete':
        flatten(n.children, bold, href, out, defs);
        break;
      case 'link': {
        const label = n.children.length === 1 && n.children[0]!.type === 'text' ? (n.children[0] as { value: string }).value : null;
        if (label !== null && label === n.url) out.push({ text: hostOf(n.url), ...(bold ? { bold } : {}), href: n.url });
        else flatten(n.children, bold, n.url, out, defs);
        break;
      }
      case 'linkReference':
        // The label is the visible text; the address comes from the matching definition, if there is one.
        flatten(n.children, bold, defs.get(n.identifier) ?? href, out, defs);
        break;
      default:
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

/** Where the first sentence of `text` ends (after its . ! or ?), or -1: a period after an abbreviation, or before a lowercase word or a number ("Oct. 15"), is no end. */
function sentenceEnd(text: string): number {
  for (const m of text.matchAll(/[.!?](?=\s|$)/g)) {
    const i = m.index!;
    if (text[i] === '.') {
      const word = text.slice(0, i).split(/\s/).pop() ?? '';
      if (/^(?:\p{L}\.)+\p{L}$/u.test(word)) continue;
      if (ABBREVIATIONS.has(word.toLowerCase())) continue;
    }
    const next = /^\s+(\S)/.exec(text.slice(i + 1))?.[1];
    if (next === undefined || !/[\p{Ll}\d]/u.test(next)) return i + 1;
  }
  return -1;
}

/** Keeps spans up to the first sentence end. */
function firstSentence(spans: DigestSpan[]): DigestSpan[] {
  const out: DigestSpan[] = [];
  for (const s of spans) {
    const end = s.href ? -1 : sentenceEnd(s.text);
    if (end !== -1) {
      out.push({ ...s, text: s.text.slice(0, end) });
      return out;
    }
    out.push(s);
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

/**
 * Compact highlights from a policy digest section: for each top-level bullet its bold lead, or else its first sentence,
 * clipped on rendered text. The full digest lives on Sponsorship.
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
      return l;
    })() : null;
    const line = clip(tidy(lead ?? firstSentence(tidy(spans))));
    if (line.length === 0) continue;
    out.push(line);
    if (out.length === max) break;
  }
  return out;
}

// Envelope contract: one per line, outside code fences: <<cc:KIND {json}>>. The server validates the payloads; the
// transcript only needs the text around them, so both read envelopes out of the text with this one walker.

const OPENER_RE = /<<cc:([a-z-]+)\s+\{/g;

export interface RawEnvelope {
  kind: string;
  json: string;
  raw: string;
}

/**
 * Index of the `}` that closes the JSON object opening at `start`, skipping braces inside strings, or -1 when the
 * object is still open at the end of the line.
 */
function jsonObjectEnd(line: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Takes the envelopes out of one line. A well-formed object ends at its balanced `}` (so a `}>>` inside a string is
 * kept); malformed JSON ends at the first `}>>`, so it still comes back as an envelope the server flags. With
 * `hidePartial` (the streaming tail), an envelope still open at the end of the line is hidden from its opener on.
 */
function takeEnvelopes(line: string, found: RawEnvelope[], hidePartial: boolean): { rest: string; matched: boolean } {
  let rest = '';
  let pos = 0;
  let matched = false;
  OPENER_RE.lastIndex = 0;
  for (let m = OPENER_RE.exec(line); m; m = OPENER_RE.exec(line)) {
    const brace = m.index + m[0].length - 1;
    const close = jsonObjectEnd(line, brace);
    if (close === -1 && hidePartial) return { rest: rest + line.slice(pos, m.index), matched };
    const end = close !== -1 && line.startsWith('>>', close + 1) ? close : line.indexOf('}>>', brace);
    if (end === -1) {
      OPENER_RE.lastIndex = m.index + 1;
      continue;
    }
    matched = true;
    found.push({ kind: m[1]!, json: line.slice(brace, end + 1), raw: line.slice(m.index, end + 3) });
    rest += line.slice(pos, m.index);
    pos = end + 3;
    OPENER_RE.lastIndex = pos;
  }
  rest += line.slice(pos);
  if (hidePartial) {
    const open = rest.lastIndexOf('<<cc:');
    if (open !== -1 && !rest.slice(open).includes('>>')) rest = rest.slice(0, open);
  }
  return { rest, matched };
}

/**
 * Splits assistant text into its envelopes and the text a reader sees. Fenced lines are left alone, and while streaming
 * a partial opener at the end is hidden (alpha behavior).
 */
export function splitEnvelopes(text: string, streaming: boolean): { found: RawEnvelope[]; visibleText: string } {
  const found: RawEnvelope[] = [];
  const visible: string[] = [];
  let inFence = false;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      visible.push(line);
      return;
    }
    if (inFence) {
      visible.push(line);
      return;
    }
    const { rest, matched } = takeEnvelopes(line, found, streaming && i === lines.length - 1);
    if (!matched) visible.push(rest);
    else if (rest.trim()) visible.push(rest.trimEnd());
  });
  return { found, visibleText: visible.join('\n') };
}

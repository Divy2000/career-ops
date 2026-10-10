// Envelope contract: one per line, outside code fences: <<cc:KIND {json}>>. The server validates the payloads; the
// transcript only needs the text around them, so both read envelopes out of the text with this one walker.

// Non-greedy braces end at the first `}>>`, which is the envelope's own closer even with nested objects.
const ENVELOPE_RE = /<<cc:([a-z-]+)\s+(\{.*?\})>>/g;

export interface RawEnvelope {
  kind: string;
  json: string;
  raw: string;
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
    let matched = false;
    const rest = line.replace(ENVELOPE_RE, (raw, kind: string, json: string) => {
      matched = true;
      found.push({ kind, json, raw });
      return '';
    });
    if (matched) {
      if (rest.trim()) visible.push(rest.trimEnd());
      return;
    }
    if (streaming && i === lines.length - 1) {
      const open = line.lastIndexOf('<<cc:');
      if (open !== -1 && !line.slice(open).includes('>>')) {
        visible.push(line.slice(0, open));
        return;
      }
    }
    visible.push(line);
  });
  return { found, visibleText: visible.join('\n') };
}

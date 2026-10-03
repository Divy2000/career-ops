const MAX_CHARS = 160;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Compact highlights from a policy digest section: for each top-level bullet its bold lead, or else its first sentence.
 * Bare URLs shrink to their host; markdown links stay (the renderer wraps them). The full digest lives on Sponsorship.
 */
export function summarizeDigest(body: string, max = 4): string[] {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const m = /^[-*]\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    const text = m[1]!;
    const lead = /^\*\*(.+?)\*\*/.exec(text);
    const plain = (lead ? lead[1]! : (/^(.*?[.!?])(?=\s|$)/.exec(text)?.[1] ?? text)).replace(/(?<!\]\()https?:\/\/[^\s)\]]+/g, hostOf);
    const clipped = plain.length > MAX_CHARS ? `${plain.slice(0, MAX_CHARS).trimEnd()}\u2026` : plain;
    out.push(lead ? `**${clipped}**` : clipped);
    if (out.length === max) break;
  }
  return out;
}

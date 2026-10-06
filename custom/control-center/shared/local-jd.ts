// A pipeline row can stand for a saved JD instead of a posting URL: archive-posting prints `local:jds/<file>` to paste
// into pipeline.md, and the Apify provider appends one for a posting it saved a description for. Pipeline and triage
// mode read the file (modes/pipeline.md: the `local:` prefix).

/** The jds/ file a `local:jds/<file>` pipeline reference names, or null for anything else (no other folder, no ..). */
export function localJdPath(ref: string): string | null {
  const m = /^local:(jds\/[^\s|\0]+)$/.exec(ref.trim());
  if (!m || m[1]!.length > 512) return null;
  return m[1]!.split('/').some((seg) => seg === '' || seg === '.' || seg === '..') ? null : m[1]!;
}

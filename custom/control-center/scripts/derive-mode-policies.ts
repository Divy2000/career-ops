// Reads every modes/**/*.md (excluding `_` files and READMEs) and records the
// id, title, referenced scripts and repo paths. The CLI writes the frozen
// snapshot that server/claude/modes.ts consumes; a test compares the two.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DerivedMode {
  id: string;
  file: string;
  title: string;
  scripts: string[];
  paths: string[];
}

const SCRIPT_RE = /\b(?:node|bash)\s+((?:[\w.-]+\/)*[\w.-]+\.(?:mjs|sh))\b/g;
const PATH_RE = /(?<![\w/])((?:data|reports|output|config|modes|templates|interview-prep|jds|batch|custom|plugins|writing-samples|documents)\/[\w./*-]+)/g;
const ROOT_FILES = ['cv.md', 'portals.yml', 'article-digest.md', 'voice-dna.md', 'applications.md'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

export function deriveModes(codeRoot: string): DerivedMode[] {
  const modesDir = path.join(codeRoot, 'modes');
  const files = walk(modesDir).filter((f) => {
    const base = path.basename(f);
    return !base.startsWith('_') && base.toLowerCase() !== 'readme.md';
  });
  return files
    .map((file) => {
      const rel = path.relative(modesDir, file).split(path.sep).join('/');
      const text = fs.readFileSync(file, 'utf8');
      // Upstream titles use U+2014; the frozen snapshot is text we commit, so it is spelled as a dash.
      const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? rel).split(String.fromCharCode(0x2014)).join('-').trim();
      const scripts = new Set<string>();
      for (const m of text.matchAll(SCRIPT_RE)) scripts.add(m[1]!.replace(/^\.\//, ''));
      const paths = new Set<string>();
      for (const m of text.matchAll(PATH_RE)) paths.add(m[1]!.replace(/[.,:;)]+$/, ''));
      for (const f of ROOT_FILES) if (new RegExp(`(?<![\\w/])${f.replace('.', '\\.')}\\b`).test(text)) paths.add(f);
      return {
        id: rel.replace(/\.md$/, ''),
        file: `modes/${rel}`,
        title,
        scripts: [...scripts].sort(),
        paths: [...paths].sort(),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === here) {
  const codeRoot = path.resolve(path.dirname(here), '..', '..', '..');
  const out = path.resolve(path.dirname(here), '..', 'server', 'claude', 'modes.generated.json');
  const modes = deriveModes(codeRoot);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(modes, null, 2) + '\n');
  console.log(`wrote ${modes.length} modes to ${path.relative(process.cwd(), out)}`);
}

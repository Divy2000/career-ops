// Typed access to the projects library helpers (custom/projects/lib.mjs, a
// contracted pure module). The library file itself is article-digest.md.
import { importCore } from '../core/adapter.js';

export type ProjectKind = 'project' | 'publication' | 'article';

export interface ProjectInput {
  title: string;
  url?: string | null;
  tagline?: string | null;
  tags?: string[];
  kind?: ProjectKind;
  dates?: string | null;
  bullets: string[];
}

export interface LibraryEntry {
  id: string;
  title: string;
  url: string | null;
  tagline: string | null;
  tags: string[];
  kind: string;
  dates: string | null;
  bullets: string[];
  line: number;
  /** Character offsets of the entry block in the file (heading through last content line). */
  start: number;
  end: number;
}

export interface Validation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface ProjectsLib {
  parseLibrary: (text: string) => { preamble: string; entries: LibraryEntry[] };
  validateLibrary: (text: string) => Validation;
  serializeEntry: (entry: ProjectInput) => string;
  serializeLibrary: (entries: ProjectInput[]) => string;
  replaceEntry: (text: string, id: string, entry: ProjectInput) => string;
  appendEntry: (text: string, entry: ProjectInput) => string;
  appendBlock: (text: string, block: string) => string;
  removeEntry: (text: string, id: string) => string;
  convertJsonProjects: (data: unknown) => { entries: ProjectInput[]; warnings: string[] };
  findCvEntry: (cvText: string, title: string) => { line: number; text: string } | null;
  titleKey: (title: string) => string;
}

export function projectsLib(codeRoot: string): Promise<ProjectsLib> {
  return importCore<ProjectsLib>(codeRoot, 'custom/projects/lib.mjs');
}

/** GET /api/projects */
export interface ProjectView {
  id: string;
  title: string;
  url: string | null;
  tagline: string | null;
  tags: string[];
  kind: string;
  dates: string | null;
  bullets: string[];
  line: number;
  inCv: boolean;
}

export interface ProjectsRead {
  path: string;
  kind: 'ok' | 'missing';
  etag: string | null;
  entries: ProjectView[];
  validation: Validation;
}

/** POST /api/projects/convert */
export interface ConvertResult {
  markdown: string;
  entries: Array<{ title: string }>;
  duplicates: string[];
  warnings: string[];
  errors: string[];
}

/** projects.rank action result (custom/projects/rank.mjs --json). */
export interface RankCandidate {
  id: string;
  title: string;
  url: string | null;
  kind: string;
  inCv: boolean;
  score: number;
  matchedSkills: string[];
  bullets: string[];
}

export interface RankResult {
  recommended: string[];
  candidates: RankCandidate[];
  excluded: Array<{ id: string; title: string; kind: string }>;
  libraryCoverage: Record<string, string[]>;
}

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
  removeEntry: (text: string, id: string) => string;
  convertJsonProjects: (data: unknown) => { entries: ProjectInput[]; warnings: string[] };
  findCvEntry: (cvText: string, title: string) => { line: number; text: string } | null;
  titleKey: (title: string) => string;
}

export function projectsLib(codeRoot: string): Promise<ProjectsLib> {
  return importCore<ProjectsLib>(codeRoot, 'custom/projects/lib.mjs');
}

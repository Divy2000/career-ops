export interface TutorialManifest {
  id: string;
  title: string;
  description: string;
  video: string;
  subtitles?: string;
  poster?: string;
  transcript?: string;
  guide?: string;
  chapters: Array<{ title: string; start: number }>;
}
export type ManifestResult = { ok: true; manifest: TutorialManifest } | { ok: false; error: string };
export const ID_RE: RegExp;
export function extOf(name: string): string;
export function parseManifest(value: unknown, folder: string): ManifestResult;
export interface GuideSection {
  id: string;
  title: string;
  summary: string;
  route?: string;
  gif: string;
  poster?: string;
  steps: string[];
  tips?: string[];
  chapter?: number;
}
export interface TutorialGuideFile {
  sections: GuideSection[];
}
export type GuideResult = { ok: true; guide: TutorialGuideFile } | { ok: false; error: string };
export const MAX_GUIDE_SECTIONS: number;
export const MAX_GUIDE_BYTES: number;
export function parseGuide(value: unknown, opts: { chapterCount: number }): GuideResult;
export function guideFileNames(guide: TutorialGuideFile): string[];
